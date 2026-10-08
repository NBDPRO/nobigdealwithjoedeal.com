#!/usr/bin/env node
/**
 * scripts/check-firestore-indexes.js — static scan: does every compound
 * Firestore query in functions/ and docs/pro/js have the index it needs in
 * firestore.indexes.json?
 *
 * WHY (2026-10-04)
 * ────────────────
 * The emulator NEVER enforces indexes (memory: callWatch was green locally and
 * died FAILED_PRECONDITION in prod). So a query that needs a composite index
 * passes every unit test, every emulator suite and every E2E shard, and fails
 * only in production — usually inside a try/catch that turns it into an empty
 * list. This scan is the only pre-merge check that reads the queries and the
 * index file together.
 *
 * What it understands (best effort, string literals only):
 *   admin SDK   db.collection('x').where('a','==',v).orderBy('b','desc')…
 *               db.collectionGroup('x')…, …doc(id).collection('sub')…
 *   modular     query(collection(db,'x'[, id, 'sub']), where(...), orderBy(...))
 *               query(collectionGroup(db,'x'), ...), window.query/window.where…
 * A query whose collection or any field is not a string literal is skipped
 * (counted as "dynamic"), never guessed.
 *
 * Needs a composite when it combines more than one field and at least one of
 * them is an orderBy, an inequality, or array-contains (equality-only queries
 * are served by index merging). A collectionGroup query ALSO needs a
 * COLLECTION_GROUP-scope single-field index for each field it filters/orders
 * on, because those are not created automatically (fieldOverrides).
 *
 * Used by tests/firestore-index-coverage-2026-10-04.test.js (with an allowlist
 * for reviewed false positives). CLI: node scripts/check-firestore-indexes.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EQ_OPS = new Set(['==', 'in']);
const ARR_OPS = new Set(['array-contains', 'array-contains-any']);
const INEQ_OPS = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);

// ── tiny lexer helpers ─────────────────────────────────────────────────────
/** Index just past the matching close paren for the '(' at `open`; skips strings/comments/templates. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j;
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') { const e = matchParen(src, j + 1); if (e < 0) return src.length; j = e - 1; }
  }
  return src.length;
}
/** Split a call's argument text on top-level commas. */
function splitArgs(inner) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === '`') { const e = skipString(inner, i); cur += inner.slice(i, e + 1); i = e; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function lit(s) {
  const m = String(s || '').trim().match(/^(['"])([^'"\\]*)\1$/);
  return m ? m[2] : null;
}
function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

/** Parse where/orderBy argument lists into a constraint; null = dynamic. */
function constraint(kind, args) {
  if (kind === 'where') {
    const f = lit(args[0]), op = lit(args[1]);
    if (f == null || op == null) return null;
    return { kind, field: f, op };
  }
  if (kind === 'orderBy') {
    const f = lit(args[0]);
    if (f == null) return null;
    const d = args[1] ? lit(args[1]) : 'asc';
    return { kind, field: f, dir: (d || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc' };
  }
  return { kind };
}

/**
 * Scan one source file → queries:
 * { file, line, collection, group, where:[{field,op}], orderBy:[{field,dir}], dynamic }
 */
function scanSource(src, file) {
  const out = [];
  // Admin SDK chains: walk .where/.orderBy/.limit… from position i.
  function chain(i, q) {
    let touched = false;
    for (;;) {
      const rest = src.slice(i, i + 4000);
      const cm = rest.match(/^\s*(?:\/\/[^\n]*\s*)*\.\s*([A-Za-z_]\w*)\s*\(/);
      if (!cm) break;
      const name = cm[1];
      const open = i + cm[0].length - 1;
      const close = matchParen(src, open);
      if (close < 0) break;
      if (name === 'where' || name === 'orderBy') {
        const c = constraint(name, splitArgs(src.slice(open + 1, close - 1)));
        if (!c) q.dynamic = true; else q[name === 'where' ? 'where' : 'orderBy'].push(c);
        touched = true;
      } else if (!/^(limit|limitToLast|startAfter|startAt|endBefore|endAt|select|offset|withConverter)$/.test(name)) {
        break; // .get(), .onSnapshot(), .doc(), .count() … end of the query part
      }
      i = close;
    }
    q._end = i;
    return touched;
  }
  const reAdmin = /\.(collection|collectionGroup)\(\s*(['"])([^'"]+)\2\s*\)/g;
  let m;
  while ((m = reAdmin.exec(src))) {
    const q = { file, line: lineOf(src, m.index), collection: m[3].split('/').pop(), group: m[1] === 'collectionGroup', where: [], orderBy: [], dynamic: false, style: 'admin' };
    if (chain(m.index + m[0].length, q)) out.push(q);
  }
  // "const col = db.collection('x')[.where(...)…];" … "col.where(...)" — a
  // same-file ref variable whose initialiser is a collection query chain; each
  // later use extends the initialiser's constraints.
  const reRef = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?\.(collection|collectionGroup)\(\s*(['"])([^'"]+)\3\s*\)/g;
  while ((m = reRef.exec(src))) {
    const name = m[1], coll = m[4].split('/').pop(), group = m[2] === 'collectionGroup';
    const baseQ = { where: [], orderBy: [], dynamic: false };
    chain(m.index + m[0].length, baseQ);
    if (!/^\s*;/.test(src.slice(baseQ._end, baseQ._end + 20))) continue; // initialiser ends in .get() etc. — not a ref
    const reUse = new RegExp('(^|[^.\\w$])' + name.replace(/\$/g, '\\$') + '(?=\\s*\\.\\s*(?:where|orderBy)\\s*\\()', 'g');
    let u;
    while ((u = reUse.exec(src))) {
      const q = { file, line: lineOf(src, u.index), collection: coll, group, where: baseQ.where.slice(), orderBy: baseQ.orderBy.slice(), dynamic: baseQ.dynamic, style: 'admin-ref' };
      if (chain(u.index + u[0].length, q)) out.push(q);
    }
  }
  // Modular query(...) calls — bare or namespace-prefixed (window., w., fs., mod. …).
  const reQ = /(^|[^.\w$])(?:[A-Za-z_$][\w$]*\.)?query\s*\(/g;
  while ((m = reQ.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = splitArgs(src.slice(open + 1, close - 1));
    if (!args.length) continue;
    // `const col = collection(db, 'x'); … query(col, …)` — resolve a plain
    // identifier to its same-file collection(...) initialiser (first one wins).
    if (/^[A-Za-z_$][\w$]*$/.test(args[0])) {
      const decl = new RegExp('(?:const|let|var)\\s+' + args[0].replace(/\$/g, '\\$') + '\\s*=\\s*((?:[A-Za-z_$][\\w$]*\\.)?collection(?:Group)?\\s*\\()').exec(src);
      if (decl) {
        const o = decl.index + decl[0].length - 1;
        const c = matchParen(src, o);
        if (c > 0) args[0] = src.slice(decl.index + decl[0].length - decl[1].length, c);
      }
    }
    const base = args[0].match(/^(?:[A-Za-z_$][\w$]*\.)?(collection|collectionGroup)\s*\(([\s\S]*)\)$/);
    if (!base) continue;
    const bargs = splitArgs(base[2]);
    const group = base[1] === 'collectionGroup';
    const segs = bargs.slice(1);
    const last = segs.length ? lit(segs[segs.length - 1]) : null;
    if (last == null || segs.length % 2 === 0) continue; // dynamic path / doc ref → skip
    const q = { file, line: lineOf(src, m.index), collection: last.split('/').pop(), group, where: [], orderBy: [], dynamic: false, style: 'modular' };
    let touched = false;
    for (const a of args.slice(1)) {
      const cm = a.match(/^(?:[A-Za-z_$][\w$]*\.)?(where|orderBy|limit|limitToLast|startAfter|startAt|endBefore|endAt)\s*\(([\s\S]*)\)$/);
      if (!cm) { if (/^\.\.\./.test(a) || /^[A-Za-z_$][\w$.]*$/.test(a)) q.dynamic = true; continue; }
      if (cm[1] === 'where' || cm[1] === 'orderBy') {
        const c = constraint(cm[1], splitArgs(cm[2]));
        if (!c) q.dynamic = true; else q[cm[1] === 'where' ? 'where' : 'orderBy'].push(c);
        touched = true;
      }
    }
    if (touched) out.push(q);
  }
  return out;
}

/** What a query needs. */
function requirement(q) {
  const eq = [], arr = [], ineq = [];
  for (const w of q.where) {
    if (EQ_OPS.has(w.op)) eq.push(w.field);
    else if (ARR_OPS.has(w.op)) arr.push(w.field);
    else if (INEQ_OPS.has(w.op)) ineq.push(w.field);
  }
  const order = q.orderBy.filter((o) => o.field !== '__name__').map((o) => ({ field: o.field, dir: o.dir }));
  // An inequality's field is implicitly the first sort key when not ordered explicitly.
  for (const f of ineq) if (!order.some((o) => o.field === f)) order.unshift({ field: f, dir: null });
  const fields = new Set([...eq, ...arr, ...ineq, ...order.map((o) => o.field)]);
  const composite = fields.size >= 2 && (order.length > 0 || arr.length > 0);
  return { eq: [...new Set(eq)], arr: [...new Set(arr)], order, fields: [...fields], composite };
}

/** Does a composite index serve the requirement? */
function indexServes(ix, req, group) {
  const scope = ix.queryScope || 'COLLECTION';
  if (group ? scope !== 'COLLECTION_GROUP' : scope !== 'COLLECTION') return false;
  const F = ix.fields.filter((f) => f.fieldPath !== '__name__');
  const prefix = new Set([...req.eq, ...req.arr]);
  const head = F.slice(0, prefix.size);
  if (head.length !== prefix.size || !head.every((f) => prefix.has(f.fieldPath))) return false;
  for (const f of head) {
    if (req.arr.includes(f.fieldPath) ? f.arrayConfig !== 'CONTAINS' : !!f.arrayConfig) return false;
  }
  const tail = F.slice(prefix.size);
  if (tail.length < req.order.length) return false;
  for (let k = 0; k < req.order.length; k++) {
    const o = req.order[k], f = tail[k];
    if (f.fieldPath !== o.field || f.arrayConfig) return false;
    if (o.dir && (o.dir === 'desc') !== (f.order === 'DESCENDING')) return false;
  }
  return true;
}

/** COLLECTION_GROUP single-field index present for `field` on `coll`? */
function groupFieldIndexed(overrides, coll, field) {
  return (overrides || []).some((o) => o.collectionGroup === coll && o.fieldPath === field
    && (o.indexes || []).some((i) => i.queryScope === 'COLLECTION_GROUP'));
}

/** Findings for a list of queries against an index file. */
function check(queries, indexFile) {
  const findings = [];
  for (const q of queries) {
    if (q.dynamic) continue;
    const req = requirement(q);
    const key = q.collection + (q.group ? '[group]' : '') + ' where(' + q.where.map((w) => w.field + ' ' + w.op).join(', ') + ')'
      + (q.orderBy.length ? ' orderBy(' + q.orderBy.map((o) => o.field + ' ' + o.dir).join(', ') + ')' : '');
    if (req.composite) {
      const served = (indexFile.indexes || []).some((ix) => ix.collectionGroup === q.collection && indexServes(ix, req, q.group));
      if (!served) findings.push({ kind: 'composite', key, file: q.file, line: q.line, req });
    } else if (q.group) {
      // Equality/one-field collectionGroup query: served by a CG composite
      // whose leading fields cover it, or by CG single-field overrides.
      const byComposite = (indexFile.indexes || []).some((ix) => ix.collectionGroup === q.collection && indexServes(ix, req, true));
      const missing = byComposite ? [] : req.fields.filter((f) => !groupFieldIndexed(indexFile.fieldOverrides, q.collection, f));
      if (missing.length) findings.push({ kind: 'group-field', key, file: q.file, line: q.line, missing });
    }
  }
  return findings;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(ent.name) && !/\.min\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** Scan the repo's two query surfaces. */
function scanRepo(root = ROOT) {
  const files = [...walk(path.join(root, 'functions')), ...walk(path.join(root, 'docs', 'pro', 'js'))];
  const queries = [];
  for (const f of files) queries.push(...scanSource(fs.readFileSync(f, 'utf8'), path.relative(root, f).replace(/\\/g, '/')));
  return { files: files.length, queries };
}

if (require.main === module) {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  const { files, queries } = scanRepo();
  const findings = check(queries, idx);
  console.log('scanned ' + files + ' files, ' + queries.length + ' queries (' + queries.filter((q) => q.dynamic).length + ' dynamic, skipped)');
  for (const f of findings) console.log((f.kind === 'composite' ? 'MISSING COMPOSITE  ' : 'MISSING CG FIELD   ') + f.file + ':' + f.line + '  ' + f.key + (f.missing ? '  [' + f.missing.join(',') + ']' : ''));
  console.log(findings.length + ' finding(s)');
}

module.exports = { scanSource, requirement, indexServes, groupFieldIndexed, check, scanRepo };
