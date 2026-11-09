/**
 * tests/call-brief-eval-init-2026-11-09.test.js — the live-eval kit for Jo
 * (Jo follow-ups lane "evalkit", 2026-11-09): `scripts/eval-call-brief.js
 * --init <dir>` and the runbook documentation/runbooks/CALL-BRIEF-LIVE-EVAL.md.
 *
 *   - --init writes N empty, valid label skeletons (no real data) plus a
 *     README into a directory OUTSIDE the repo, and refuses a path inside the
 *     repo (or inside any git work tree, or through a symlink into one), an
 *     existing non-empty directory, and a bad --count
 *   - the label checker (validateCase) passes the skeletons and the fixtures,
 *     and names a typo'd field key, a bad promise and a non-YYYY-MM-DD date
 *   - blank skeletons are skipped, never sent: a run over a fresh --init dir
 *     makes no model call even with --live and a (fake) key
 *   - a filled skeleton scores; a label problem stops a run before any call
 *   - the runbook is linked from INDEX.md, names every field key and promise
 *     kind the script reads, the model switch, and carries one worked
 *     fictional example that passes the checker
 *
 * No network (fetch is a tripwire), no API key (a fake one built at runtime).
 * Run: node tests/call-brief-eval-init-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let fetchCalls = 0;
global.fetch = async () => { fetchCalls++; throw new Error('network in a test'); };

const E = require(path.join(ROOT, 'scripts', 'eval-call-brief.js'));
const B = require(path.join(ROOT, 'functions', 'call-brief-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const quiet = async (fn) => { const log = console.log, err = console.error; const out = []; console.log = (...a) => out.push(a.join(' ')); console.error = console.log; try { return { code: await fn(), out: out.join('\n') }; } finally { console.log = log; console.error = err; } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-evalkit-'));
const FAKE_KEY = 'sk-' + 'ant-' + 'test-not-a-real-key';

(async () => {
  const made = [];
  try {
    console.log('\n--init writes the kit');
    ok('the script exports validateCase and initCases', typeof E.validateCase === 'function' && typeof E.initCases === 'function');
    const base = tmp(); made.push(base);
    const dir = path.join(base, 'nbd-call-eval');
    const r = await quiet(() => E.main(['--init', dir], {}));
    ok('--init <new dir> exits 0', r.code === 0, r.out);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    const caseFiles = files.filter((f) => /^case-\d{2}\.json$/.test(f));
    ok('20 case files by default, plus README.md, nothing else', caseFiles.length === 20 && files.includes('README.md') && files.length === 21, files);
    const cases = caseFiles.length ? E.loadCases(dir) : [];
    ok('loadCases reads all 20 skeletons', cases.length === 20, cases.length);
    ok('every skeleton passes the label checker', cases.length === 20 && cases.every((c) => E.validateCase(c).length === 0), cases.map((c) => E.validateCase(c)).filter((p) => p.length));
    ok('ids are unique and match the file names', new Set(cases.map((c) => c.id)).size === 20 && caseFiles.every((f, i) => cases[i] && cases[i].id === f.replace('.json', '')));
    ok('no real data: empty transcript, no labelled fields, no promises, no canned answer', cases.every((c) => c.transcript === '' && Object.keys(c.expect.fields).length === 0 && c.expect.promises.length === 0 && c.canned === null));
    const allText = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    ok('no phone-number-shaped digits anywhere in the kit', !/\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/.test(allText));
    const fx = JSON.parse(fs.readFileSync(E.FIXTURES, 'utf8'));
    ok('no fixture transcript copied into the kit', fx.cases.every((c) => !allText.includes(c.transcript.slice(0, 40))));
    ok('a skeleton is a human-filed call by default (it passes the gate once a transcript is in)', cases.every((c) => B.humanFiledProblem(Object.assign({}, c.call, { transcript: 'x' })) === ''));
    const readme = files.includes('README.md') ? fs.readFileSync(path.join(dir, 'README.md'), 'utf8') : '';
    ok('README: never commit, points at the runbook, gives the Haiku and Sonnet commands', /never/i.test(readme) && /commit/i.test(readme) && /documentation\/runbooks\/CALL-BRIEF-LIVE-EVAL\.md/.test(readme)
      && /--live --cases/.test(readme) && /--model claude-sonnet-5-5/.test(readme), readme.slice(0, 300));
    if (process.platform !== 'win32') {
      ok('the kit folder is private to Jo (0700)', (fs.statSync(dir).mode & 0o777) === 0o700, (fs.statSync(dir).mode & 0o777).toString(8));
      ok('every kit file is private to Jo (0600)', files.every((f) => (fs.statSync(path.join(dir, f)).mode & 0o777) === 0o600), files.map((f) => f + ':' + (fs.statSync(path.join(dir, f)).mode & 0o777).toString(8)));
    }
    const keySafe = (t) => !/ANTHROPIC_API_KEY=\S/.test(t) && /read -rs ANTHROPIC_API_KEY/.test(t) && /export ANTHROPIC_API_KEY/.test(t) && /unset ANTHROPIC_API_KEY/.test(t);
    ok('README: the key is read silently, never typed into a command (no shell history), and unset after', keySafe(readme), readme.split('\n').filter((l) => /ANTHROPIC_API_KEY/.test(l)));
    ok('README holds no key', !/sk-ant-/.test(readme) && !/ANTHROPIC_API_KEY=\S*[a-z0-9]{8}/i.test(readme));

    const r3dir = path.join(base, 'three');
    const r3 = await quiet(() => E.main(['--init', r3dir, '--count', '3'], {}));
    ok('--count 3 writes case-01..case-03', r3.code === 0 && fs.readdirSync(r3dir).filter((f) => /^case-/.test(f)).length === 3, r3.out);
    const emptyExisting = tmp(); made.push(emptyExisting);
    const re = await quiet(() => E.main(['--init', emptyExisting, '--count', '2'], {}));
    ok('an existing EMPTY dir outside the repo is fine', re.code === 0 && fs.readdirSync(emptyExisting).length === 3, re.out);

    console.log('\n--init refuses');
    const inRepo = path.join(ROOT, 'evalkit-should-not-exist');
    const a = await quiet(() => E.main(['--init', inRepo], {}));
    ok('a path inside the repo: exit 2, nothing written', a.code === 2 && !fs.existsSync(inRepo) && /inside/i.test(a.out), a.out);
    const b = await quiet(() => E.main(['--init', ROOT], {}));
    ok('the repo root itself: exit 2', b.code === 2 && !fs.existsSync(path.join(ROOT, 'case-01.json')));
    const c = await quiet(() => E.main(['--init', path.join(ROOT, 'tests', 'fixtures', 'evalkit-x')], {}));
    ok('a deep path inside the repo: exit 2', c.code === 2 && !fs.existsSync(path.join(ROOT, 'tests', 'fixtures', 'evalkit-x')));
    const otherRepo = tmp(); made.push(otherRepo);
    fs.mkdirSync(path.join(otherRepo, '.git'));
    const d = await quiet(() => E.main(['--init', path.join(otherRepo, 'sub', 'eval')], {}));
    ok('a path inside ANY git work tree: exit 2', d.code === 2 && !fs.existsSync(path.join(otherRepo, 'sub')), d.out);
    const linkBase = tmp(); made.push(linkBase);
    const link = path.join(linkBase, 'into-repo');
    fs.symlinkSync(path.join(ROOT, 'tests'), link);
    const e = await quiet(() => E.main(['--init', path.join(link, 'evalkit-via-link')], {}));
    ok('a symlink that leads into the repo: exit 2', e.code === 2 && !fs.existsSync(path.join(ROOT, 'tests', 'evalkit-via-link')), e.out);
    const busy = tmp(); made.push(busy);
    fs.writeFileSync(path.join(busy, 'case-01.json'), '{"keep":"me"}');
    const f = await quiet(() => E.main(['--init', busy], {}));
    ok('a non-empty dir: exit 2, Jo\'s labels untouched', f.code === 2 && fs.readFileSync(path.join(busy, 'case-01.json'), 'utf8') === '{"keep":"me"}' && fs.readdirSync(busy).length === 1, f.out);
    const g = await quiet(() => E.main(['--init'], {}));
    ok('--init with no dir: exit 2', g.code === 2);
    for (const bad of ['0', '101', 'abc', '2.5']) {
      const bd = path.join(base, 'bad-' + bad.replace('.', '_'));
      const h = await quiet(() => E.main(['--init', bd, '--count', bad], {}));
      ok('--count ' + bad + ' refused, nothing written', h.code === 2 && !fs.existsSync(bd));
    }

    console.log('\nBlank skeletons never reach a model');
    const off = await quiet(() => E.main(['--cases', dir], {}));
    ok('offline over a fresh kit: exit 2, says nothing is filled in', off.code === 2 && /no filled/i.test(off.out), off.out);
    const live = await quiet(() => E.main(['--live', '--cases', dir], { ANTHROPIC_API_KEY: FAKE_KEY }));
    ok('--live with a key over a fresh kit: exit 2, zero network calls', live.code === 2 && fetchCalls === 0, live.out);

    console.log('\nA filled skeleton scores');
    const claim = fx.cases.find((x) => x.kind === 'claim');
    const sk = JSON.parse(fs.readFileSync(path.join(dir, 'case-01.json'), 'utf8'));
    Object.assign(sk, JSON.parse(JSON.stringify({ kind: claim.kind, callYmd: claim.callYmd, direction: claim.direction, transcript: claim.transcript, expect: claim.expect, canned: claim.canned })));
    fs.writeFileSync(path.join(dir, 'case-01.json'), JSON.stringify(sk, null, 2));
    const one = await quiet(() => E.main(['--cases', dir], {}));
    ok('offline: 1 case scored, 19 blanks skipped, exit 0', one.code === 0 && /1 cases/.test(one.out) && /skipped 19/i.test(one.out) && /case-01/.test(one.out), one.out);
    sk.expect.fields = Object.assign({}, sk.expect.fields, { insCarier: 'State Farm' });
    fs.writeFileSync(path.join(dir, 'case-01.json'), JSON.stringify(sk, null, 2));
    const typo = await quiet(() => E.main(['--live', '--cases', dir], { ANTHROPIC_API_KEY: FAKE_KEY }));
    ok('a typo\'d field key stops a --live run before any call (exit 2, names it)', typo.code === 2 && /insCarier/.test(typo.out) && fetchCalls === 0, typo.out);

    console.log('\nA hand-broken file is named');
    const broken = tmp(); made.push(broken);
    fs.writeFileSync(path.join(broken, 'case-01.json'), '{ "id": "case-01", "transcript": "he said "hi" then" }');
    let thrown = null; try { E.loadCases(broken); } catch (err) { thrown = err; }
    ok('loadCases names the bad file and says it is not valid JSON', !!thrown && /case-01\.json/.test(thrown.message) && /JSON/.test(thrown.message), thrown && thrown.message);
    const bm = await quiet(() => E.main(['--cases', broken], {}).catch((err) => { console.error(err.message); return 1; }));
    ok('a run over it fails naming the file, no model call', bm.code !== 0 && /case-01\.json/.test(bm.out) && fetchCalls === 0, bm.out);

    console.log('\nThe label checker');
    ok('every synthetic fixture passes', fx.cases.every((x) => E.validateCase(x).length === 0), fx.cases.map((x) => [x.id, E.validateCase(x)]));
    const base1 = JSON.parse(JSON.stringify(claim));
    const probs = (mut) => { const x = JSON.parse(JSON.stringify(base1)); mut(x); return E.validateCase(x).join(' | '); };
    ok('unknown field key', /insCarier/.test(probs((x) => { x.expect.fields.insCarier = 'Erie'; })));
    ok('promise who off jo/them', /who/.test(probs((x) => { x.expect.promises[0].who = 'me'; })));
    ok('promise kind off the list', /kind/.test(probs((x) => { x.expect.promises[0].kind = 'visit'; })));
    ok('a "them" promise that is not waiting', /waiting/.test(probs((x) => { x.expect.promises[1].kind = 'estimate'; })));
    ok('a date label that is not YYYY-MM-DD', /dateOfLoss/.test(probs((x) => { x.expect.fields.dateOfLoss = 'Nov 3'; })));
    ok('jobType off insurance/cash', /jobType/.test(probs((x) => { x.expect.fields.jobType = 'retail'; })));
    ok('workKind off repair/replace', /workKind/.test(probs((x) => { x.expect.fields.workKind = 'new'; })));
    ok('a filled case with no call date', /callYmd/.test(probs((x) => { x.callYmd = ''; })));
    ok('reliable / refused must be true or false', /reliable/.test(probs((x) => { x.expect.reliable = 'yes'; })) && /refused/.test(probs((x) => { delete x.expect.refused; })));
    ok('a missing id', /id/.test(probs((x) => { x.id = ''; })));

    console.log('\nThe runbook');
    const rbPath = path.join(ROOT, 'documentation', 'runbooks', 'CALL-BRIEF-LIVE-EVAL.md');
    const rb = fs.existsSync(rbPath) ? fs.readFileSync(rbPath, 'utf8') : '';
    ok('documentation/runbooks/CALL-BRIEF-LIVE-EVAL.md exists', !!rb);
    const index = fs.readFileSync(path.join(ROOT, 'documentation', 'INDEX.md'), 'utf8');
    ok('linked from INDEX.md with a plain relative link', /\]\(runbooks\/CALL-BRIEF-LIVE-EVAL\.md\)/.test(index));
    ok('names every field key the script scores', B.FIELD_KEYS.every((k) => rb.includes('`' + k + '`')), B.FIELD_KEYS.filter((k) => !rb.includes('`' + k + '`')));
    ok('names every promise kind', B.PROMISE_KINDS.every((k) => rb.includes('`' + k + '`')), B.PROMISE_KINDS);
    ok('the commands: --init, Haiku default, the Sonnet run, every --bar-*', /--init/.test(rb) && /--live --cases/.test(rb) && /--model claude-sonnet-5-5/.test(rb)
      && ['precision', 'claim', 'promise', 'reliable'].every((k) => rb.includes('--bar-' + k)));
    ok('says where the default model lives (BRIEF_MODEL in functions/call-brief-logic.js)', /BRIEF_MODEL/.test(rb) && /functions\/call-brief-logic\.js/.test(rb) && rb.includes(B.BRIEF_MODEL));
    ok('says never commit transcripts', /never commit/i.test(rb));
    const m = /<!-- worked-example:start -->\s*```json\s*([\s\S]*?)```\s*<!-- worked-example:end -->/.exec(rb);
    let ex = null; try { ex = m && JSON.parse(m[1]); } catch (_) { ex = null; }
    ok('one worked example in a marked json block that parses', !!ex);
    ok('the worked example passes the label checker', !!ex && E.validateCase(ex).length === 0, ex && E.validateCase(ex));
    ok('the worked example is fictional (555 numbers only, an Example street)', !!ex && /Example/.test(ex.transcript) && (!/\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/.test(ex.transcript) || /555/.test(ex.transcript)));
    if (ex) {
      const sc = await E.runEval({ cases: [ex] });
      ok('the worked example runs through the offline harness', sc.rows.length === 1 && sc.rows[0].gate === true, sc.rows[0]);
    }
    ok('runbook: the key is read silently, never typed into a command (no shell history), and unset after', keySafe(rb), rb.split('\n').filter((l) => /ANTHROPIC_API_KEY/.test(l)));
    const hm = /<!-- transcript-helper:start -->\s*```bash\s*([\s\S]*?)```\s*<!-- transcript-helper:end -->/.exec(rb);
    ok('step 4 gives a marked one-line helper instead of escaping by hand', !!hm && !/replace each `"` with `\\"`/.test(rb), hm && hm[1]);
    if (hm) {
      const home = tmp(); made.push(home);
      const kit = path.join(home, 'nbd-call-eval');
      await quiet(() => E.main(['--init', kit, '--count', '1'], {}));
      const said = 'He said "the back slope\\ridge" leaks.\r\nThen: "call me Tuesday."\n';
      fs.writeFileSync(path.join(kit, 'case-01.txt'), said);
      const run = require('child_process').spawnSync('bash', ['-c', hm[1]], { cwd: ROOT, env: Object.assign({}, process.env, { HOME: home }), encoding: 'utf8' });
      let filled = null; try { filled = JSON.parse(fs.readFileSync(path.join(kit, 'case-01.json'), 'utf8')); } catch (_) { filled = null; }
      ok('the helper puts a transcript with quotes, a backslash and line breaks into case-01.json as valid JSON (the rest of the file untouched; callYmd is still Jo\'s to fill)', run.status === 0 && !!filled && filled.transcript === said.trim() && filled.id === 'case-01' && E.validateCase(filled).every((m) => /^callYmd/.test(m)), [run.status, run.stderr, filled && filled.transcript]);
    }
    ok('runbook: a home folder that is itself a git repo (dotfiles) is refused, so pick a folder outside it', /dotfiles/i.test(rb) && /home folder is itself a git/i.test(rb));
    ok('no key in the runbook', !/sk-ant-[A-Za-z0-9]/.test(rb));
    ok('still no network', fetchCalls === 0);
  } finally {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
