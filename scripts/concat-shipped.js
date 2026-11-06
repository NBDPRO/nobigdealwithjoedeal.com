#!/usr/bin/env node
/**
 * scripts/concat-shipped.js — join the CRM dashboard's boot `defer` scripts into a few files at DEPLOY time
 * (CRM speed-up Phase 2, documentation/projects/CRM-SPEED-UP-PHASE2-DESIGN-2026-11-04.md).
 *
 * Like scripts/minify-shipped.js, docs/ stays the readable source of truth; --write only ever runs on the deploy
 * job's runner checkout (after minify, before `firebase deploy`). Run order is unchanged: deferred classic scripts and
 * module scripts run in one shared document order, so a group is only ever a run of CONSECUTIVE eligible `defer`
 * scripts, broken by every module, blocking/async script and ineligible file.
 *
 * A defer tag is ELIGIBLE (joinable) only when all of these hold; otherwise it stays its own tag and ends the group:
 *   - exactly `defer` + `src`, src is `js/<file>.js` directly under docs/pro/js (the joined file lives there too, so a
 *     relative import() in a joined file resolves exactly as before);
 *   - not a file the sample account's worker swaps by exact path (explore/demo-sw.js EMPTY_SCRIPTS / SWAPS);
 *   - not a file in a ScriptLoader bundle (the loader skips a file whose <script src> is on the page; joined, its tag
 *     is gone and the loader would inject it twice);
 *   - not named by a `script[src*="…"]` selector anywhere in docs/pro/js (code that finds its own tag);
 *   - no `document.currentScript`, no top-level 'use strict' directive (it would govern every file after it);
 *   - the top-level scanner (scripts/lib/toplevel-scan.js) reads it to depth 0.
 *
 * REFUSALS (exit 1, nothing written; the deploy stops): inside one group,
 *   - a top-level function / let / const / class name declared in two files (one file = last copy wins for all code;
 *     a duplicate lexical name is a SyntaxError for the whole group);
 *   - an earlier file naming a later file's top-level let / const / class (TDZ: `typeof x` would throw);
 *   - the group, joined, failing to compile (V8's own check).
 *
 * --write: writes docs/pro/js/_concat-<n>-<hash>.js per group (each file preceded by a `/*! concat: js/x.js *\/`
 * marker, separated by `;`), replaces the group's first tag with one tag for the joined file, removes the rest, and
 * points any `<link rel="preload" as="script">` for a joined file at its group file instead.
 *
 * USAGE:
 *   node scripts/concat-shipped.js --check            # plan + checks on the committed tree; exit 1 on a refusal
 *   node scripts/concat-shipped.js --write [--root D] # rewrite D/docs (default: this checkout) — deploy copy only
 *   add --json to print the plan as JSON.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { topLevelDecls, codeOnly } = require('./lib/toplevel-scan.js');

const MIN_GROUP = 2;

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; }
const key = (src) => String(src).split('#')[0].split('?')[0].replace(/^\.\//, '');

/** Ranges of the HTML that are not live markup: comments and <template> bodies. */
function deadRanges(html) {
  const out = [];
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<template\b[\s\S]*?<\/template>/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Every live <script>…</script> tag, in document order. */
function scriptTags(html) {
  const dead = deadRanges(html);
  const inDead = (i) => dead.some(([a, b]) => i >= a && i < b);
  const tags = [];
  for (const m of html.matchAll(/<script\b([^>]*)>\s*<\/script>/g)) {
    if (inDead(m.index)) continue;
    const attrs = m[1];
    const src = (attrs.match(/\bsrc="([^"]+)"/) || [])[1] || null;
    const names = [...attrs.matchAll(/\b([a-z-]+)(?:="[^"]*")?/g)].map((x) => x[1]).sort().join(' ');
    let kind = 'other';
    if (/\btype="module"/.test(attrs)) kind = 'module';
    else if (names === 'defer src' && src) kind = 'defer';
    tags.push({ start: m.index, end: m.index + m[0].length, text: m[0], src, kind });
  }
  return tags;
}

function exclusionSets(root) {
  const proJs = path.join(root, 'docs/pro/js');
  const demoSw = fs.readFileSync(path.join(root, 'docs/pro/explore/demo-sw.js'), 'utf8');
  const demo = new Set();
  for (const block of [(demoSw.match(/EMPTY_SCRIPTS = new Set\(\[([\s\S]*?)\]\)/) || [])[1], (demoSw.match(/SWAPS = new Map\(\[([\s\S]*?)\]\)\s*;/) || [])[1]]) {
    for (const m of String(block || '').matchAll(/'\/pro\/(js\/[^']+)'/g)) demo.add(key(m[1]));
  }
  const loaderSrc = fs.readFileSync(path.join(proJs, 'script-loader.js'), 'utf8');
  // Every js/… path quoted anywhere in script-loader.js counts as a bundle file. Deliberately not tied to the BUNDLES
  // literal's layout: a minified script-loader.js once made a layout-bound regex read an EMPTY list, which would have
  // joined loader files (2026-11-04). Over-matching only keeps a file separate, which is always safe. An empty result
  // is refused outright.
  const bundled = new Set([...loaderSrc.matchAll(/["'`]((?:\.\/)?js\/[\w./-]+\.js(?:\?[^"'`]*)?)["'`]/g)].map((m) => key(m[1])));
  if (bundled.size === 0) throw new Error(`concat-shipped: read only ${bundled.size} ScriptLoader bundle files from script-loader.js; refusing to guess`);
  const selectorNames = new Set();
  for (const f of fs.readdirSync(proJs).filter((x) => x.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(proJs, f), 'utf8').matchAll(/script\[src\*=\\?["']([^"'\\]+)\\?["']\]/g)) selectorNames.add(m[1]);
  }
  return { demo, bundled, selectorNames };
}

function eligibility(root, tag, ex) {
  if (tag.kind !== 'defer') return 'not a plain defer tag';
  const k = key(tag.src);
  if (!/^js\/[\w.-]+\.js$/.test(k)) return 'not directly under docs/pro/js';
  if (k.startsWith('js/_concat-')) return 'already a joined file';
  const file = path.join(root, 'docs/pro', k);
  if (!fs.existsSync(file)) return 'file missing';
  if (ex.demo.has(k)) return 'swapped by the sample account worker';
  if (ex.bundled.has(k)) return 'also in a ScriptLoader bundle';
  if ([...ex.selectorNames].some((n) => k.includes(n))) return 'found by a script[src*=] selector';
  const text = fs.readFileSync(file, 'utf8');
  if (/document\.currentScript/.test(text)) return 'uses document.currentScript';
  const scan = topLevelDecls(text);
  if (scan.useStrict) return "top-level 'use strict'";
  if (!scan.balanced) return 'scanner could not read it to depth 0';
  return null;
}

function plan(root) {
  const htmlPath = path.join(root, 'docs/pro/dashboard.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const tags = scriptTags(html);
  const ex = exclusionSets(root);
  const groups = [];
  const kept = [];
  let run = [];
  const flush = () => { if (run.length >= MIN_GROUP) groups.push(run); run = []; };
  for (const t of tags) {
    const why = eligibility(root, t, ex);
    if (why) { if (t.kind === 'defer') kept.push({ src: t.src, why }); flush(); continue; }
    run.push(t);
  }
  flush();
  const refusals = [];
  groups.forEach((g, gi) => {
    const files = g.map((t) => [key(t.src), fs.readFileSync(path.join(root, 'docs/pro', key(t.src)), 'utf8')]);
    const decl = files.map(([, text]) => topLevelDecls(text).names);
    const code = files.map(([, text]) => codeOnly(text)); // comments and string text blanked: only real code counts
    const seen = new Map();
    decl.forEach((names, i) => { for (const n of names) (seen.get(n) || seen.set(n, []).get(n)).push(files[i][0]); });
    for (const [n, where] of seen) if (where.length > 1) refusals.push(`group ${gi + 1}: "${n}" is declared at top level in ${where.join(' and ')}`);
    files.forEach(([name, text], j) => {
      const lexical = [...decl[j]].filter((n) => new RegExp(`^(?:let|const|class)\\s+${n.replace(/\$/g, '\\$')}\\b`, 'm').test(text));
      for (const n of lexical) {
        const re = new RegExp(`(^|[^\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`);
        for (let i = 0; i < j; i++) if (re.test(code[i])) refusals.push(`group ${gi + 1}: ${files[i][0]} names "${n}", a top-level let/const/class of the later ${name} (TDZ)`);
      }
    });
    try { new vm.Script(files.map(([, t]) => t).join('\n;\n'), { filename: `group-${gi + 1}.js` }); }
    catch (e) { refusals.push(`group ${gi + 1}: does not compile joined: ${e.message}`); }
  });
  return { htmlPath, html, tags, groups, kept, refusals };
}

// ── Phase 2b: lazy ScriptLoader bundles (--bundles) ─────────────────────────────────────────────────────────────
// The bundle list is read by RUNNING script-loader.js in a sandbox (window.ScriptLoader.bundles), so a minified
// loader reads exactly like the readable one.
function loaderBundles(root) {
  const src = fs.readFileSync(path.join(root, 'docs/pro/js/script-loader.js'), 'utf8');
  const quiet = { log() {}, warn() {}, group() {}, groupEnd() {}, error() {} };
  const doc = { querySelector: () => null, querySelectorAll: () => [], baseURI: 'https://nobigdealwithjoedeal.com/pro/dashboard', createElement: () => ({ setAttribute() {} }), head: { appendChild() {} } };
  const win = { document: doc, console: quiet };
  win.window = win;
  const ctx = vm.createContext({ window: win, document: doc, console: quiet, URL, setTimeout: () => 0, clearTimeout() {}, Promise });
  vm.runInContext(src, ctx, { filename: 'script-loader.js' });
  const b = win.ScriptLoader && win.ScriptLoader.bundles;
  if (!b || !Object.keys(b).length) throw new Error('concat-shipped: script-loader.js exposed no bundles; refusing to guess');
  return b;
}

function groupProblems(root, keys) {
  const files = keys.map((k) => [k, fs.readFileSync(path.join(root, 'docs/pro', k), 'utf8')]);
  const problems = [];
  const decl = files.map(([, t]) => topLevelDecls(t).names);
  const code = files.map(([, t]) => codeOnly(t));
  const seen = new Map();
  decl.forEach((names, i) => { for (const n of names) (seen.get(n) || seen.set(n, []).get(n)).push(files[i][0]); });
  for (const [n, where] of seen) if (where.length > 1) problems.push(`"${n}" declared in ${where.join(' and ')}`);
  files.forEach(([name, text], j) => {
    for (const n of [...decl[j]].filter((x) => new RegExp(`^(?:let|const|class)\\s+${x.replace(/\$/g, '\\$')}\\b`, 'm').test(text))) {
      const re = new RegExp(`(^|[^\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`);
      for (let i = 0; i < j; i++) if (re.test(code[i])) problems.push(`${files[i][0]} names "${n}" of the later ${name} (TDZ)`);
    }
  });
  try { new vm.Script(files.map(([, t]) => t).join('\n;\n')); } catch (e) { problems.push('does not compile joined: ' + e.message); }
  return problems;
}

/** → { plans: { name: { steps, parts } }, segments: [{ bundle, file, keys }], skipped: [string] } */
function planBundles(root, pageTags) {
  const bundles = loaderBundles(root);
  const ex = exclusionSets(root);
  const onPage = new Set(pageTags.filter((t) => t.src).map((t) => key(t.src)));
  const uses = {};
  for (const list of Object.values(bundles)) for (const s of list) uses[key(s)] = (uses[key(s)] || 0) + 1;
  const plans = {}, segments = [], skipped = [];
  for (const [name, list] of Object.entries(bundles)) {
    const steps = [], parts = {};
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const keys = run.map(key);
        const problems = groupProblems(root, keys);
        if (!problems.length) {
          const seg = { bundle: name, index: segments.filter((s) => s.bundle === name).length + 1, keys, srcs: run.slice() };
          segments.push(seg);
          steps.push(seg);
          run = [];
          return;
        }
        skipped.push(`${name}: kept separate (${problems.slice(0, 2).join('; ')})`);
      }
      steps.push(...run);
      run = [];
    };
    for (const src of list) {
      const k = key(src);
      let why = null;
      if (!/^js\/[\w.-]+\.js$/.test(k)) why = 'not a js/ file';
      else if (uses[k] > 1) why = 'shared with another bundle';
      else if (onPage.has(k)) why = 'also a tag on the page';
      else if (ex.demo.has(k)) why = 'demo-swapped';
      else if ([...ex.selectorNames].some((n) => k.includes(n))) why = 'selector';
      else if (!fs.existsSync(path.join(root, 'docs/pro', k))) why = 'missing';
      else {
        const t = fs.readFileSync(path.join(root, 'docs/pro', k), 'utf8');
        const scan = topLevelDecls(t);
        if (/document\.currentScript/.test(t)) why = 'currentScript';
        else if (scan.useStrict) why = 'use strict';
        else if (!scan.balanced) why = 'unreadable';
      }
      if (why) { flush(); steps.push(src); } else run.push(src);
    }
    flush();
    if (steps.some((s) => typeof s === 'object')) plans[name] = { steps, parts };
  }
  return { plans, segments, skipped };
}

function writeBundles(root, html, bp) {
  for (const seg of bp.segments) {
    const body = seg.keys.map((k) => `/*! concat: ${k} */\n${fs.readFileSync(path.join(root, 'docs/pro', k), 'utf8').replace(/\s+$/, '')}\n;\n`).join('');
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 10);
    seg.file = `js/_bundle-${seg.bundle}-${seg.index}-${hash}.js`;
    fs.writeFileSync(path.join(root, 'docs/pro', seg.file), body);
  }
  const map = {};
  for (const [name, plan] of Object.entries(bp.plans)) {
    const parts = {};
    const steps = plan.steps.map((s) => { if (typeof s !== 'object') return s; parts[s.file] = s.srcs; return s.file; });
    map[name] = { steps, parts };
  }
  const mapBody = `/* Deploy-time joined ScriptLoader bundles (scripts/concat-shipped.js --bundles). Read by script-loader.js. */\nwindow.__NBD_JOINED_BUNDLES = ${JSON.stringify(map)};\n`;
  const mapFile = `js/_bundle-map-${crypto.createHash('sha256').update(mapBody).digest('hex').slice(0, 10)}.js`;
  fs.writeFileSync(path.join(root, 'docs/pro', mapFile), mapBody);
  // The map runs just before script-loader.js, with the loader tag's own loading attributes.
  const tags = scriptTags(html);
  const loaderTag = tags.find((t) => t.src && key(t.src) === 'js/script-loader.js');
  if (!loaderTag) throw new Error('concat-shipped: no script-loader.js tag to put the bundle map before');
  const attrs = loaderTag.text.replace(/^<script\b|><\/script>$/g, '').replace(/\s*src="[^"]*"/, '');
  return html.slice(0, loaderTag.start) + `<script${attrs} src="${mapFile}"></script>\n` + html.slice(loaderTag.start);
}

function write(root, p, bp) {
  let html = p.html;
  const edits = []; // [start, end, replacement], applied from the end
  const fileOf = new Map();
  p.groups.forEach((g, gi) => {
    const body = g.map((t) => {
      const k = key(t.src);
      return `/*! concat: ${k} */\n${fs.readFileSync(path.join(root, 'docs/pro', k), 'utf8').replace(/\s+$/, '')}\n;\n`;
    }).join('');
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 10);
    const name = `js/_concat-${gi + 1}-${hash}.js`;
    fs.writeFileSync(path.join(root, 'docs/pro', name), body);
    g.forEach((t, i) => {
      fileOf.set(key(t.src), name);
      if (i === 0) { edits.push([t.start, t.end, `<script defer src="${name}"></script>`]); return; }
      // Remove the tag, plus its line when the tag was alone on it.
      let s = t.start, e = t.end;
      const ls = html.lastIndexOf('\n', s - 1) + 1;
      const le = html.indexOf('\n', e);
      if (/^[ \t]*$/.test(html.slice(ls, s)) && /^[ \t\r]*$/.test(html.slice(e, le < 0 ? html.length : le))) { s = ls; e = le < 0 ? html.length : le + 1; }
      edits.push([s, e, '']);
    });
  });
  // Preload hints for joined files point at their group file (once per group file).
  const preloaded = new Set();
  for (const m of html.matchAll(/<link rel="preload" href="([^"]+)" as="script">/g)) {
    const target = fileOf.get(key(m[1]));
    if (!target) continue;
    edits.push([m.index, m.index + m[0].length, preloaded.has(target) ? '' : `<link rel="preload" href="${target}" as="script">`]);
    preloaded.add(target);
  }
  edits.sort((a, b) => b[0] - a[0]);
  for (const [s, e, r] of edits) html = html.slice(0, s) + r + html.slice(e);
  if (bp) html = writeBundles(root, html, bp);
  fs.writeFileSync(p.htmlPath, html);
  return html;
}

function main() {
  const root = path.resolve(arg('--root') || path.join(__dirname, '..'));
  const p = plan(root);
  const bp = process.argv.includes('--bundles') ? planBundles(root, p.tags) : null;
  const grouped = p.groups.reduce((n, g) => n + g.length, 0);
  const summary = {
    scriptTags: p.tags.length,
    groups: p.groups.map((g) => g.length),
    joinedFiles: grouped,
    scriptTagsAfter: p.tags.length - grouped + p.groups.length,
    bundles: bp ? { joined: bp.segments.map((g) => g.bundle + '#' + g.index + '(' + g.keys.length + ')'), skipped: bp.skipped } : null,
    keptDefer: p.kept,
    refusals: p.refusals,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`concat-shipped: ${p.tags.length} boot script tags; ${p.groups.length} group(s) of ${summary.groups.join(' + ')} defer files → ${summary.scriptTagsAfter} tags.`);
    const why = {}; for (const k of p.kept) why[k.why] = (why[k.why] || 0) + 1;
    if (bp) console.log(`  bundles (--bundles): ${bp.segments.length} joined segment(s) in ${Object.keys(bp.plans).length} bundle(s), ${bp.segments.reduce((n, g) => n + g.keys.length, 0)} files: ${bp.segments.map((g) => g.bundle + '(' + g.keys.length + ')').join(' ')}${bp.skipped.length ? '; kept separate: ' + bp.skipped.join(' | ') : ''}`);
    console.log('  defer files kept separate: ' + (Object.entries(why).map(([w, n]) => `${n} ${w}`).join('; ') || 'none'));
  }
  if (p.refusals.length) {
    console.error('concat-shipped: REFUSED — nothing written:\n  ' + p.refusals.join('\n  '));
    process.exit(1);
  }
  if (process.argv.includes('--write')) { write(root, p, bp); console.log(`concat-shipped: wrote ${p.groups.length} joined file(s) and rewrote ${path.relative(root, p.htmlPath)}.`); }
  else if (!process.argv.includes('--check')) { console.log('(dry run: pass --check in CI, --write on the deploy copy)'); }
}

if (require.main === module) main();
module.exports = { plan, write, scriptTags, eligibility, exclusionSets, key, planBundles, loaderBundles };
