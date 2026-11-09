/**
 * tests/voicemail-viewer-hidden-2026-11-09.test.js — Call to Close Q11 item 4
 * (Jo, 2026-11-09): a viewer does not read voicemail transcripts.
 *
 * voicemail.js wrote its timeline row as source 'rep', type 'voicemail', with
 * the full transcript and an AI summary. A viewer reads activity rows of
 * source 'rep' and 'visit-capture' (firestore.rules allowlist), so a direct
 * read returned them. Now:
 *
 *   1. voicemail.js writes source 'voicemail' (outside the viewer allowlist);
 *      the recording origin stays in mediaSource.
 *   2. firestore.rules lets a client create source 'voicemail' only with type
 *      'voicemail', and type 'voicemail' only with source 'voicemail' (an old
 *      cached client's source 'rep' voicemail is refused, not filed where a
 *      viewer reads it). The viewer read allowlist is unchanged.
 *   3. The viewer timeline query (NBDCallTimeline.activityQuery) is unchanged:
 *      one where('source', 'in', ['rep', 'visit-capture']), no orderBy, so it
 *      is served by the automatic single-field index; firestore.indexes.json
 *      has no activity composite and no override that would turn the `source`
 *      single-field index off.
 *   4. Every client reader of voicemail rows is a non-viewer whole-collection
 *      read or an admin-SDK server read; none filters on source 'rep'.
 *
 * The rule half is proven on the emulator in
 * tests/firestore-rules.voicemail-viewers.test.js. Zero deps. Run:
 *   node tests/voicemail-viewer-hidden-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Drop comment lines (and trailing // comments) so a comment never satisfies a check.
const code = (s) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');

// ── 1. the writer ─────────────────────────────────────────────────────────
{
  const VM = code(read('docs/pro/js/voicemail.js'));
  const s = VM.indexOf('async function writeActivityEntry(');
  const body = s < 0 ? '' : VM.slice(s, VM.indexOf('return ref.id;', s));
  ok('voicemail.js has writeActivityEntry', !!body);
  ok('the voicemail row is written with source \'voicemail\'', /\bsource:\s*'voicemail'/.test(body), body.match(/\bsource:[^,\n]*/g));
  ok('…and never with source \'rep\'', !/\bsource:\s*'rep'/.test(body));
  ok('…still type \'voicemail\'', /\btype:\s*'voicemail'/.test(body));
  ok('…the recording origin is kept in mediaSource', /\bmediaSource:\s*source\b/.test(body));
}

// ── 2. the rules ──────────────────────────────────────────────────────────
const RULES = read('firestore.rules');
const actStart = RULES.indexOf('match /activity/{activityId} {');
const actRule = actStart < 0 ? '' : RULES.slice(actStart, RULES.indexOf('allow update, delete: if false;', actStart));
{
  ok('firestore.rules has the lead activity match', !!actRule);
  ok('the viewer read allowlist is unchanged: rep and visit-capture only',
    /&& \(notViewer\(\) \|\| resource\.data\.source in \['rep', 'visit-capture'\]\);/.test(actRule));
  const create = actRule.slice(actRule.indexOf('allow create:'));
  ok('create: source \'rep\' with any allowlisted type except voicemail',
    /request\.resource\.data\.source == 'rep'\s*&& request\.resource\.data\.type in \[[^\]]*\]/.test(create)
      && !/request\.resource\.data\.source == 'rep'\s*&& request\.resource\.data\.type in \[[^\]]*'voicemail'[^\]]*\]/.test(create));
  ok('create: source \'voicemail\' only with type \'voicemail\'',
    /request\.resource\.data\.source == 'voicemail'\s*&& request\.resource\.data\.type == 'voicemail'/.test(create));
  ok('create: the financial / webhook key denylist still applies to every client row',
    /!\(request\.resource\.data\.keys\(\)\.hasAny\(\[/.test(create) && /'stripeInvoiceId'/.test(create));
}

// ── 3. the viewer query and the indexes ───────────────────────────────────
{
  const CT = require(path.join(ROOT, 'docs/pro/js/call-timeline.js'));
  ok('the viewer sources are still rep and visit-capture (voicemail is not one)',
    JSON.stringify(CT.VIEWER_SOURCES) === JSON.stringify(['rep', 'visit-capture']));
  const W = {
    _userClaims: { role: 'viewer' },
    collection: (db, ...p) => ({ col: p.join('/') }),
    where: (f, op, v) => ({ kind: 'where', f, op, v }),
    orderBy: () => ({ kind: 'orderBy' }),
    query: (c, ...cs) => ({ col: c.col, cs }),
  };
  const q = CT.activityQuery(W, {}, 'L1');
  ok('the viewer query is one where(source in [...]) and nothing else',
    q && q.cs && q.cs.length === 1 && q.cs[0].kind === 'where' && q.cs[0].f === 'source' && q.cs[0].op === 'in'
      && JSON.stringify(q.cs[0].v) === JSON.stringify(['rep', 'visit-capture']), q);
  const IDX = JSON.parse(read('firestore.indexes.json'));
  const comp = (IDX.indexes || []).filter((i) => i.collectionGroup === 'activity');
  ok('firestore.indexes.json has no composite index on activity (none needed)', comp.length === 0, comp.length);
  const ov = (IDX.fieldOverrides || []).filter((o) => o.collectionGroup === 'activity' && o.fieldPath === 'source');
  ok('…and no field override on activity.source (the automatic single-field index serves the in-query)', ov.length === 0, ov);
}

// ── 4. readers of voicemail rows ──────────────────────────────────────────
{
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) files.push(p);
    }
  })(path.join(ROOT, 'docs/pro/js'));
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p);
    }
  })(path.join(ROOT, 'functions'));
  // A reader that keys a voicemail row on source 'rep' would lose it.
  const bad = files.filter((f) => {
    const s = code(fs.readFileSync(f, 'utf8'));
    return /type\s*===?\s*'voicemail'[^\n]*source\s*===?\s*'rep'|source\s*===?\s*'rep'[^\n]*type\s*===?\s*'voicemail'/.test(s);
  }).map((f) => path.relative(ROOT, f));
  ok('no reader keys a voicemail row on source \'rep\'', bad.length === 0, bad);
}

// ── cache key ─────────────────────────────────────────────────────────────
{
  const html = read('docs/pro/dashboard.html');
  const m = /js\/voicemail\.js\?v=(\d+)/.exec(html);
  ok('dashboard.html loads voicemail.js at v=5 or later (the changed file)', !!m && Number(m[1]) >= 5, m && m[1]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
