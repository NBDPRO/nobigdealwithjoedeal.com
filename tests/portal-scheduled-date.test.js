/* portal-scheduled-date.test.js
 *
 * "When is the crew coming?" is the question a homeowner opens the portal to
 * answer, and the portal could not answer it: lead.scheduledDate never reached
 * getHomeownerPortalView. crm-stages.js requires that field on EVERY track to
 * reach CREW_SCHEDULED (tests/crm-required-fields.test.js guards it), so from
 * that stage on it is a real commitment a rep typed — it was simply never sent.
 *
 * The plumbing is trivial. The DATE ARITHMETIC is not, and it is already wrong
 * elsewhere in this repo:
 *
 *   new Date('2026-09-16').toLocaleDateString(...)  →  "Tuesday, September 15"
 *
 * in America/New_York, because the string parses as UTC midnight. That is the
 * wrong day AND the wrong weekday, and the weekday is the half that matters —
 * it is what a homeowner writes on the calendar. The same bug is live on the
 * warranty certificate (customer-bootstrap.module.js:3296); this suite does not
 * cover that, it is a separate document.
 *
 * So the timezone assertions run the REAL lifted function in CHILD PROCESSES
 * under real TZ values, west and east of UTC. Testing it only in the host's
 * timezone would prove nothing: on a UTC runner the buggy and correct versions
 * agree exactly, which is how this class of bug reaches production.
 *
 * The second requirement is honesty. A date that has passed means the job
 * slipped or the card is stale, so "Crew arrives Tuesday" would be false. Past
 * dates state the record and promise nothing.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PORTAL = read('docs/pro/js/portal.js');
const PORTAL_FN = read('functions/portal.js');
const PORTAL_HTML = read('docs/pro/portal.html');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── lift the two pure functions ── */
function lift(name) {
  const start = PORTAL.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const end = PORTAL.indexOf('\n  }\n', start);
  return end < 0 ? null : PORTAL.slice(start, end + '\n  }\n'.length);
}
const lineSrc = lift('_scheduleLine');
const todaySrc = lift('_localToday');

group('Both helpers are present and liftable', () => {
  assert('found _scheduleLine in docs/pro/js/portal.js', !!lineSrc,
    'if it moved, update the extractor — do NOT delete the suite');
  assert('found _localToday', !!todaySrc);
});
if (!lineSrc || !todaySrc) {
  console.log('\ncannot continue'); console.log(passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
}
const ctx = { Date, RegExp, String, Number };
vm.createContext(ctx);
vm.runInContext(lineSrc + '\n' + todaySrc + '\nthis.__l = _scheduleLine; this.__t = _localToday;', ctx);
const line = ctx.__l;
const localToday = ctx.__t;

// Read results defensively. A break that makes _scheduleLine return null —
// swapping in the naive new Date(ymd) does exactly that, because the validity
// guard then rejects its own output — must redden ONE assertion, not throw.
// A throw truncates the run before the summary line, and a harness that looks
// for that line scores the whole case as CRASH instead of the redden it is.
const whenOf = (r) => (r && typeof r.when === 'string' ? r.when : null);
const textOf = (r) => (r && typeof r.text === 'string' ? r.text : '');

/* ══════════════════════════════════════════════════════════════════
   1. THE off-by-one — in real timezones, in child processes
   ══════════════════════════════════════════════════════════════════ */
function underTZ(tz, ymd, todayYmd) {
  const runner = `
${lineSrc}
const r = _scheduleLine(${JSON.stringify(ymd)}, ${JSON.stringify(todayYmd)});
process.stdout.write(JSON.stringify(r));
`;
  const out = execFileSync(process.execPath, ['-e', runner], {
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}
// Sanity: prove the naive form really is broken in the same child, so a green
// result below is evidence about OUR code and not about the runner's clock.
function naiveUnderTZ(tz, ymd) {
  const out = execFileSync(process.execPath, ['-e',
    `process.stdout.write(new Date(${JSON.stringify(ymd)})
      .toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}))`],
  { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
  return out;
}

group('The date renders as the date, west and east of UTC', () => {
  // 2026-09-16 is a Wednesday.
  const cases = [
    ['America/New_York', 'UTC-4, where the naive form loses a day'],
    ['America/Los_Angeles', 'UTC-7'],
    ['Pacific/Auckland', 'UTC+12, the other direction'],
    ['UTC', 'the CI runner, where both forms agree'],
  ];
  // Read the text defensively. Swapping in the naive `new Date(ymd)` makes the
  // validity guard reject its own result and return NULL, so `.text` on it
  // would throw and truncate the run before the summary line — the harness then
  // reports CRASH instead of the redden this is meant to produce.
  cases.forEach(([tz, why]) => {
    const r = underTZ(tz, '2026-09-16', '2026-09-01');
    const ok = /Wednesday/.test(textOf(r)) && /September 16/.test(textOf(r));
    assert('in ' + tz + ' it says Wednesday, September 16  (' + why + ')', ok,
      JSON.stringify(r));
  });

  // The control. Without this, a passing suite could just mean the runner is
  // in a timezone where the bug is invisible.
  const naiveNY = naiveUnderTZ('America/New_York', '2026-09-16');
  assert('CONTROL: the naive new Date(ymd) really does say September 15 in New York',
    /September 15/.test(naiveNY),
    'got ' + JSON.stringify(naiveNY) + ' — if this ever passes, the hazard changed '
    + 'and the assertions above stop being evidence');
  assert('...and our function disagrees with it, in that same timezone',
    !/September 15/.test(textOf(underTZ('America/New_York', '2026-09-16', '2026-09-01'))));
});

group('_localToday is local, not UTC', () => {
  // 02:00 UTC on the 16th is still the 15th in New York. toISOString() would
  // say the 16th and flip "today" for every evening visitor.
  const out = execFileSync(process.execPath, ['-e',
    `${todaySrc}\nprocess.stdout.write(_localToday(new Date('2026-09-16T02:00:00Z')))`],
  { env: Object.assign({}, process.env, { TZ: 'America/New_York' }), encoding: 'utf8' });
  assert('02:00Z on the 16th is still 2026-09-15 in New York', out === '2026-09-15',
    'got ' + out);
  const auck = execFileSync(process.execPath, ['-e',
    `${todaySrc}\nprocess.stdout.write(_localToday(new Date('2026-09-15T22:00:00Z')))`],
  { env: Object.assign({}, process.env, { TZ: 'Pacific/Auckland' }), encoding: 'utf8' });
  assert('22:00Z on the 15th is already 2026-09-16 in Auckland', auck === '2026-09-16',
    'got ' + auck);
  assert('it zero-pads, so the string compare against ymd is valid',
    /^\d{4}-\d{2}-\d{2}$/.test(localToday(new Date(2026, 0, 5))),
    localToday(new Date(2026, 0, 5)));
});

/* ══════════════════════════════════════════════════════════════════
   2. Honesty: a past date promises nothing
   ══════════════════════════════════════════════════════════════════ */
group('Each branch says only what is true', () => {
  const future = line('2026-09-16', '2026-09-01');
  assert('a future date promises an arrival', whenOf(future) === 'future'
    && /^Crew arrives /.test(textOf(future)), JSON.stringify(future));

  const today = line('2026-09-16', '2026-09-16');
  assert('today says today, not a weekday', whenOf(today) === 'today'
    && textOf(today) === 'Crew arrives today', JSON.stringify(today));

  const past = line('2026-09-16', '2026-09-20');
  assert('a past date is marked past', whenOf(past) === 'past', JSON.stringify(past));
  assert('a past date NEVER claims the crew is arriving',
    past !== null && !/arriv/i.test(textOf(past)),
    JSON.stringify(past) + ' — the job slipped or the card is stale; promising an '
    + 'arrival on a date that has gone by is the lie this branch exists to avoid');
  assert('...and still tells them the date on record',
    /September 16/.test(textOf(past)), JSON.stringify(past));

  // Boundaries: one day either side must not be mistaken for today.
  assert('the day before today is future', whenOf(line('2026-09-17', '2026-09-16')) === 'future');
  assert('the day after today is past', whenOf(line('2026-09-15', '2026-09-16')) === 'past');
  // Zero-padded ISO strings compare correctly as strings — including across
  // a month and a year boundary, where a naive numeric compare would not.
  assert('2026-10-01 is after 2026-09-30', whenOf(line('2026-10-01', '2026-09-30')) === 'future');
  assert('2027-01-01 is after 2026-12-31', whenOf(line('2027-01-01', '2026-12-31')) === 'future');
});

group('Bad input renders nothing, never "Invalid Date"', () => {
  [null, undefined, '', '   ', 'tomorrow', '2026-9-16', '09/16/2026', '2026-09-16T00:00:00Z',
    '2026-13-01', '2026-02-30', 'null', 0, {}, []].forEach((bad) => {
    assert('rejects ' + JSON.stringify(bad), line(bad, '2026-09-01') === null,
      'got ' + JSON.stringify(line(bad, '2026-09-01')));
  });
  assert('2026-02-30 is rejected as a date the calendar lacks (it would roll to Mar 2)',
    line('2026-02-30', '2026-01-01') === null);
  assert('a real leap day is accepted', line('2028-02-29', '2028-01-01') !== null);
});

/* ══════════════════════════════════════════════════════════════════
   3. The server sends it, and sends it raw
   ══════════════════════════════════════════════════════════════════ */
group('getHomeownerPortalView ships the date', () => {
  assert('scheduledDate is on the progress payload',
    /copy:\s+HOMEOWNER_PROGRESS_COPY\.ui,[\s\S]{0,1200}?scheduledDate: \/\^\\d\{4\}/.test(PORTAL_FN),
    'it must travel with the milestones the card already renders');
  assert('the server shape-validates it',
    /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(String\(lead\.scheduledDate \|\| ''\)\)/.test(PORTAL_FN),
    'an unvalidated value reaches a customer as "Invalid Date"');
  assert('it is sent RAW, not formatted server-side',
    !/scheduledDate:[^\n]*toLocaleDateString/.test(PORTAL_FN),
    'the function runs in UTC; formatting there is wrong for every reader');
  assert('the server does not decide past/future either',
    !/scheduledDate[\s\S]{0,200}Date\.now\(\)/.test(PORTAL_FN));
});

/* ══════════════════════════════════════════════════════════════════
   4. The card renders it, escaped, in the right place
   ══════════════════════════════════════════════════════════════════ */
group('The progress card wires it up', () => {
  assert('the schedule line is built from the server field and local today',
    /_scheduleLine\(p\.scheduledDate, _localToday\(\)\)/.test(PORTAL));
  assert('the text is escaped before it reaches innerHTML',
    /esc\(sched\.text\)/.test(PORTAL));
  assert('the branch is exposed to CSS via data-when',
    /data-when="' \+ esc\(sched\.when\)/.test(PORTAL));
  assert('it renders ABOVE "Next up" — a date beats a milestone name',
    PORTAL.indexOf('schedHtml +') < PORTAL.indexOf('nextHtml +')
      && PORTAL.indexOf('schedHtml +') > -1);
  assert('nothing renders when there is no date',
    /const schedHtml = sched\s*\?/.test(PORTAL) && /:\s*'';/.test(PORTAL),
    'an empty card row would be worse than no row');
  // The emoji is decoration; a screen reader announcing "calendar" before the
  // sentence adds nothing.
  assert('the emoji is hidden from assistive tech',
    /<span aria-hidden="true">📅<\/span>/.test(PORTAL));
});

group('The styling exists and past is visually demoted', () => {
  assert('.progress-schedule is defined', /\.progress-schedule\{/.test(PORTAL_HTML));
  assert('a past date drops to the muted treatment',
    /\.progress-schedule\[data-when="past"\]\{/.test(PORTAL_HTML),
    'a record must not be styled like a promise');
  // Every custom property this block reads must exist, or it paints a
  // hardcoded fallback in every theme — the 2026-09-07 voice-intelligence.css
  // defect, one file over.
  const block = PORTAL_HTML.slice(PORTAL_HTML.indexOf('.progress-schedule{'),
    PORTAL_HTML.indexOf('.progress-schedule + .progress-next'));
  const used = [...new Set([...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
  // Strip CSS comments from the haystack. Written against raw text this was
  // VACUOUS: the rule's own comment says "--nbd-line, not --nbd-border:", so
  // `indexOf('--nbd-border:')` found the explanation and reported the token
  // defined. A break-test swapping the good token for the bad one did not
  // redden — caught only by running that break. Fourth time this trap has
  // fired in this lane. A block-comment stripper is the right tool HERE and
  // only here: CSS has no regex literals for it to eat.
  const cssRaw = PORTAL_HTML + read('docs/pro/css/nbd-brand.css');
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  assert('the CSS comment stripper did not eat the declarations',
    css.indexOf('--nbd-line:') > -1 && css.length > cssRaw.length * 0.5,
    'kept ' + Math.round((css.length / cssRaw.length) * 100) + '%');
  const missing = used.filter((t) => css.indexOf(t + ':') === -1);
  assert('all ' + used.length + ' custom properties it reads are defined',
    missing.length === 0, 'undefined: ' + missing.join(', '));
});

group('Multi-job (2026-09-30): "Also scheduled" for a customer\'s other jobs', () => {
  // Client: lift _otherJobLines with the two line builders it reuses.
  const src = [lift('_scheduleLine'), lift('_weekLine'), lift('_otherJobLines')];
  assert('found _otherJobLines + _weekLine in docs/pro/js/portal.js', src.every(Boolean));
  if (!src.every(Boolean)) return;
  const c = { Date, RegExp, String, Number, Array };
  vm.createContext(c);
  vm.runInContext(src.join('\n') + '\nthis.__o = _otherJobLines;', c);
  const T = '2026-10-05';
  const lines = c.__o([
    { title: 'Gutter guards', scheduledDate: '2026-10-12', scheduleWindow: { scheduledStart: '09:00', scheduledDurationMin: 120 } },
    { title: 'Old repair', scheduledDate: '2026-09-20' },
    { title: 'Skylight', scheduledWeek: '2026-10-19' },
    { title: 'Last month', scheduledWeek: '2026-09-07' },
    { title: '', scheduledDate: '2026-10-20' },
  ], T);
  assert('a future day → "Crew arrives <weekday, date>" with its window kept for the suffix',
    lines.length === 2 && lines[0].title === 'Gutter guards' && /^Crew arrives Monday, October 12$/.test(lines[0].text) && lines[0].win && lines[0].win.scheduledStart === '09:00',
    JSON.stringify(lines));
  assert('a planned week → "Scheduled for the week of …"', lines[1] && lines[1].when === 'week' && /^Scheduled for the week of October 19$/.test(lines[1].text), JSON.stringify(lines[1]));
  assert('a past day / lapsed week / untitled job says nothing', !lines.some((l) => /Old repair|Last month/.test(l.title)) && lines.length === 2);
  assert('the portal renders them under the main date, escaped',
    /const otherHtml = _otherJobLines\(p\.otherJobs, _localToday\(\)\)/.test(PORTAL)
    && /Also scheduled — <strong>' \+ esc\(o\.title\) \+ '<\/strong>: ' \+ esc\(o\.text\) \+ esc\(win\)/.test(PORTAL)
    && /schedHtml \+\s*otherHtml \+\s*nextHtml/.test(PORTAL));

  // Server: lift otherJobsFor (top-level) + scheduleWindowFor with the real modules.
  const liftTop = (name) => { const s = PORTAL_FN.indexOf('function ' + name + '('); const e = PORTAL_FN.indexOf('\n}\n', s); return s < 0 || e < 0 ? null : PORTAL_FN.slice(s, e + 3); };
  const fsrc = [liftTop('scheduleWindowFor'), liftTop('otherJobsFor')];
  assert('found otherJobsFor in functions/portal.js', fsrc.every(Boolean));
  if (!fsrc.every(Boolean)) return;
  const s = { JOBS: require(path.join(ROOT, 'functions', 'jobs-logic.js')), ScheduleWindow: require(path.join(ROOT, 'functions', 'schedule-window.js')), YMD: /^\d{4}-\d{2}-\d{2}$/, String, Object, Array };
  vm.createContext(s);
  vm.runInContext(fsrc.join('\n') + '\nthis.__f = otherJobsFor;', s);
  const out = s.__f({ activeJobId: 'j1' }, [
    { id: 'j1', title: 'Roof', scheduledDate: '2026-10-06' },
    { id: 'j2', title: 'Gutter guards', stage: 'new', scheduledDate: '2026-10-12', scheduledStart: '09:00', scheduledDurationMin: 120, jobValue: 1450, claimNumber: 'C-9', crew: 'ZZ crew', notes: 'secret' },
    { id: 'j3', title: 'Done job', stage: 'closed', paidInFull: true, scheduledDate: '2026-10-20' },
    { id: 'j4', title: 'Lost job', stageRole: 'lost', scheduledDate: '2026-10-21' },
    { id: 'j5', title: 'No date yet' },
    { id: 'j6', title: 'Skylight', scheduledWeek: '2026-10-19' },
  ]);
  assert('only the customer\'s OTHER open, dated jobs go out (not the card\'s, done, lost or undated)',
    out.length === 2 && out[0].title === 'Gutter guards' && out[1].title === 'Skylight', JSON.stringify(out));
  assert('...carrying ONLY title + schedule fields (no value, claim, crew or notes)',
    JSON.stringify(Object.keys(out[0]).sort()) === JSON.stringify(['scheduleWindow', 'scheduledDate', 'scheduledWeek', 'title'])
    && !/1450|C-9|ZZ crew|secret/.test(JSON.stringify(out)));
  assert('the handler reads the jobs best-effort (a failure never blanks the portal)',
    /try \{\s*const js = await db\.collection\('leads'\)\.doc\(tok\.leadId\)\.collection\('jobs'\)\.get\(\);\s*progress\.otherJobs = otherJobsFor\(/.test(PORTAL_FN));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
