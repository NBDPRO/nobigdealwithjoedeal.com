#!/usr/bin/env node
/**
 * scripts/gen-function-map.js — writes functions/function-map.json, the
 * export-name → module map that lets a deployed function load ONLY its own
 * module (functions/index.js's FUNCTION_TARGET fast path).
 *
 * WHY (2026-10-04): functions/index.js eagerly requires ~116 modules to export
 * 237 functions. Every Gen2 function is its own Cloud Run service, so every
 * cold start of every function paid for loading all 116 (and the memory to
 * hold them — cold starts needed 256MiB+). Deploy discovery and the emulator's
 * discovery pass need the full export surface; a running instance needs one.
 *
 * How the map is derived: load functions/index.js the normal (full) way, then
 * for every exported Cloud Function find a functions/ module whose own
 * `exports[name]` IS that object (identity, not name-matching), preferring the
 * file that defines it (`exports.name =` in its source) over a re-exporter.
 * tests/functions-lazy-load-2026-10-04.test.js re-proves identity for every
 * entry, so a stale map fails CI instead of shipping.
 *
 *   node scripts/gen-function-map.js            write the map
 *   node scripts/gen-function-map.js --check    exit 1 if the committed map is stale
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FUNCTIONS = path.join(__dirname, '..', 'functions');
const MAP = path.join(FUNCTIONS, 'function-map.json');

function isCloudFunction(v) {
  return typeof v === 'function' && v.__endpoint && typeof v.__endpoint === 'object';
}

/** Build { name: './rel/module' } by loading index.js in THIS process (no FUNCTION_TARGET). */
function buildMap() {
  if (process.env.FUNCTION_TARGET) throw new Error('gen-function-map: unset FUNCTION_TARGET — the map is built from a FULL load');
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
  const quiet = console.log; console.log = () => {};
  let idx;
  try { idx = require(path.join(FUNCTIONS, 'index.js')); } finally { console.log = quiet; }
  const own = Object.keys(require.cache).filter((f) => f.startsWith(FUNCTIONS + path.sep)
    && !f.includes(path.sep + 'node_modules' + path.sep) && f !== path.join(FUNCTIONS, 'index.js'));
  const map = {};
  const problems = [];
  for (const name of Object.keys(idx).sort()) {
    const fn = idx[name];
    if (!isCloudFunction(fn)) continue;
    const hits = own.filter((f) => { const e = require.cache[f].exports; return e && e[name] === fn; });
    if (!hits.length) { problems.push(name + ': no functions/ module exports this exact object'); continue; }
    const defining = hits.filter((f) => new RegExp('exports\\.' + name + '\\s*=').test(fs.readFileSync(f, 'utf8')));
    const pick = (defining.length ? defining : hits).sort()[0];
    map[name] = './' + path.relative(FUNCTIONS, pick).replace(/\\/g, '/').replace(/\.js$/, '');
  }
  if (problems.length) throw new Error('gen-function-map:\n  ' + problems.join('\n  '));
  return map;
}

function serialize(map) { return JSON.stringify(map, null, 2) + '\n'; }

if (require.main === module) {
  const map = buildMap();
  const text = serialize(map);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(MAP) ? fs.readFileSync(MAP, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== text) { console.error('functions/function-map.json is stale — run: node scripts/gen-function-map.js'); process.exit(1); }
    console.log('function-map.json up to date (' + Object.keys(map).length + ' functions)');
  } else {
    fs.writeFileSync(MAP, text);
    console.log('wrote functions/function-map.json (' + Object.keys(map).length + ' functions)');
  }
}

module.exports = { buildMap, serialize, isCloudFunction, MAP };
