/**
 * tests/no-conflict-markers-2026-10-04.test.js
 *
 * No tracked file may carry a git conflict marker. On 2026-10-04 the #2169
 * merge committed a `<<<<<<< HEAD … >>>>>>> origin/main` block into
 * functions/FUNCTIONS_INDEX.md, and it sat on main unnoticed: requeue.sh's
 * marker check only looked at .js/.html/.css under docs/ and tests/, and no
 * suite read the markdown. This scans EVERY tracked text file, so a marker in
 * a doc, a rules file or a JSON file fails CI the same as one in code.
 *
 * Only the `<<<<<<< ` / `>>>>>>> ` lines are checked: a bare `=======` line is
 * a legal markdown setext heading underline.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); }
}

const MARKER = /^(<{7}|>{7})( |$)/m;

function scan(files) {
  const hits = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, rel)); } catch (_) { continue; } // deleted in the working tree
    if (buf.includes(0)) continue; // binary
    const text = buf.toString('utf8');
    if (!MARKER.test(text)) continue;
    text.split(/\r?\n/).forEach((line, i) => { if (/^(<{7}|>{7})( |$)/.test(line)) hits.push(rel + ':' + (i + 1)); });
  }
  return hits;
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0').filter(Boolean)
  .filter((f) => !/(^|\/)node_modules\//.test(f));

ok(files.length > 500, 'git ls-files sees the whole tree (' + files.length + ' files)');

// The detector itself: a planted marker must be found, a setext heading must not.
// Built at runtime so this file never contains a literal marker line.
const L = '<'.repeat(7), R = '>'.repeat(7);
ok(MARKER.test('a\n' + L + ' HEAD\nb\n=======\nc\n' + R + ' origin/main\n'), 'detector finds a planted conflict block');
ok(!MARKER.test('Title\n=======\ntext\n'), 'detector ignores a markdown setext heading');
ok(MARKER.test('x\r\n' + R + ' main\r\n'), 'detector finds a marker in a CRLF file');

const hits = scan(files);
ok(hits.length === 0, 'no tracked file carries a conflict marker' + (hits.length ? ': ' + hits.slice(0, 10).join(', ') : ''));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
