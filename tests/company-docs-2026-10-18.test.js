#!/usr/bin/env node
/**
 * Own-document expiry (2026-10-18): the pure status function (browser copy and
 * server copy), the form validation, the roll-up, the alert plan + de-dup, and
 * the sweep's dry-run / live behaviour against a fake Firestore.
 * docs/pro/js/company-docs-logic.js, functions/company-doc-expiry-logic.js,
 * functions/company-doc-expiry.js
 *
 * Run: node tests/company-docs-2026-10-18.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = require(path.join(ROOT, 'docs/pro/js/company-docs-logic.js'));
const S = require(path.join(ROOT, 'functions/company-doc-expiry-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const T = '2026-10-18';
const addDays = (ymd, n) => { const p = C.parseYmd(ymd); const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return d.toISOString().slice(0, 10); };

(async () => {
  console.log('A. the status bands (today = ' + T + ')');
  const st = (n) => C.statusOf(addDays(T, n), T);
  ok('31 days left = ok (positive control: a quiet doc raises nothing)', st(31).state === 'ok' && st(31).rank === 0);
  ok('30 days left = due30', st(30).state === 'due30');
  ok('15 days left = due30', st(15).state === 'due30');
  ok('14 days left = due14', st(14).state === 'due14');
  ok('8 days left = due14', st(8).state === 'due14');
  ok('7 days left = due7', st(7).state === 'due7');
  ok('1 day left = due7, singular label', st(1).state === 'due7' && /in 1 day /.test(st(1).label));
  ok('0 days left (today) = due7, "Expires today"', st(0).state === 'due7' && st(0).days === 0 && st(0).label === 'Expires today');
  ok('yesterday = expired', st(-1).state === 'expired' && st(-1).days === -1);
  ok('long ago = expired', st(-400).state === 'expired');
  ok('ranks climb with urgency (ok 0, 30 -> 1, 14 -> 2, 7 -> 3, expired 4)', [st(31), st(30), st(14), st(7), st(-1)].map((x) => x.rank).join() === '0,1,2,3,4');
  ok('no date = none', C.statusOf('', T).state === 'none' && C.statusOf(null, T).state === 'none');
  ok('an impossible date (2026-02-30) = none, not a wrong band', C.statusOf('2026-02-30', T).state === 'none');
  ok('a wrong shape (10/18/2026) = none', C.statusOf('10/18/2026', T).state === 'none');
  ok('an unreadable "today" = none, never a false alarm', C.statusOf('2026-10-20', 'garbage').state === 'none');

  console.log('B. calendar days: no off-by-one at midnight, across DST, month and year ends');
  // Independent of the UTC maths under test: step LOCAL calendar days (noon, so a DST shift cannot move the date) and compare the strings.
  const oracle = (a, b) => {
    if (a === b) return 0;
    const pa = C.parseYmd(a), dir = a < b ? 1 : -1;
    for (let n = dir; Math.abs(n) < 4000; n += dir) {
      if (C.localYmd(new Date(pa.y, pa.m - 1, pa.d + n, 12)) === b) return n;
    }
    return NaN;
  };
  let sweepBad = 0, sweepN = 0;
  for (const base of ['2026-03-01', '2026-10-25', '2026-12-20', '2027-02-20', '2028-02-20']) {
    for (let i = 0; i < 60; i++) {
      const today = addDays(base, i);
      for (const off of [-3, -1, 0, 1, 6, 7, 8, 13, 14, 15, 29, 30, 31, 45]) {
        const exp = addDays(today, off);
        const got = C.statusOf(exp, today);
        sweepN++;
        if (got.days !== off || got.days !== oracle(today, exp)) sweepBad++;
      }
    }
  }
  ok('day counts match an independent day-by-day walk over ' + sweepN + ' (today, expiry) pairs incl. DST weekends, a leap February and year end', sweepBad === 0, sweepBad + ' off');
  ok('leap day exists in 2028 and not in 2027', C.parseYmd('2028-02-29') && !C.parseYmd('2027-02-29'));
  ok('localYmd reads the LOCAL calendar date at 23:59:59', C.localYmd(new Date(2026, 9, 18, 23, 59, 59)) === '2026-10-18');
  ok('localYmd reads the LOCAL calendar date at 00:00:01', C.localYmd(new Date(2026, 9, 19, 0, 0, 1)) === '2026-10-19');
  ok('localYmd on the spring-forward day (2026-03-08, 02:30 does not exist) is that day', C.localYmd(new Date(2026, 2, 8, 3, 30)) === '2026-03-08');
  ok('localYmd on the fall-back day (2026-11-01, 01:30 happens twice) is that day', C.localYmd(new Date(2026, 10, 1, 1, 30)) === '2026-11-01');
  ok('a doc expiring 2026-11-02 viewed on the fall-back day is 1 day out', C.statusOf('2026-11-02', C.localYmd(new Date(2026, 10, 1, 23, 30))).days === 1);

  console.log('C. the server copy agrees with the browser copy');
  let diff = 0, n = 0;
  for (let i = -60; i <= 60; i++) {
    const exp = addDays(T, i);
    const a = C.statusOf(exp, T), b = S.statusOf(exp, T);
    n++;
    if (a.state !== b.state || a.days !== b.days || a.rank !== b.rank) diff++;
  }
  ok('same state / days / rank for ' + n + ' offsets', diff === 0, diff + ' differ');
  ok('same answer for a missing date and a bad date', S.statusOf('', T).state === 'none' && S.statusOf('2026-02-30', T).state === 'none');
  ok('the server reads the company-local date, not UTC (2026-10-19 01:30Z is still 2026-10-18 in New York)', S.ymdInZone(Date.parse('2026-10-19T01:30:00Z'), 'America/New_York') === '2026-10-18');
  ok('...and in a zone that is already tomorrow', S.ymdInZone(Date.parse('2026-10-19T01:30:00Z'), 'Pacific/Auckland') === '2026-10-19');
  ok('a bad zone name falls back to Eastern instead of throwing', S.ymdInZone(Date.parse('2026-10-19T01:30:00Z'), 'Not/AZone') === '2026-10-18');

  console.log('D. form validation (the same limits as firestore.rules)');
  const base = { type: 'gl_coi', name: 'GL certificate', issuer: 'Sample Insurance Co', expiry: '2027-01-31', notes: 'n', fileRef: 'Drive > Company > Insurance > COI.pdf' };
  ok('a complete form is accepted', C.clean(base).ok === true);
  ok('an unknown kind is refused', C.clean(Object.assign({}, base, { type: 'passport' })).ok === false);
  ok('a blank name is refused', C.clean(Object.assign({}, base, { name: '  ' })).ok === false);
  ok('an 81-character name is refused, 80 accepted', C.clean(Object.assign({}, base, { name: 'x'.repeat(81) })).ok === false && C.clean(Object.assign({}, base, { name: 'x'.repeat(80) })).ok === true);
  ok('an impossible expiry is refused; an empty one is accepted', C.clean(Object.assign({}, base, { expiry: '2026-13-01' })).ok === false && C.clean(Object.assign({}, base, { expiry: '' })).ok === true);
  ok('a link as the file reference is refused', C.clean(Object.assign({}, base, { fileRef: 'https://example.com/x.pdf' })).ok === false);
  ok('a Storage token link is refused', C.clean(Object.assign({}, base, { fileRef: 'photos/x.pdf?alt=media&token=abc' })).ok === false);
  ok('a firebasestorage host is refused', C.clean(Object.assign({}, base, { fileRef: 'firebasestorage.googleapis.com/v0/b/x' })).ok === false);
  ok('a plain "where it lives" note is accepted', C.clean(Object.assign({}, base, { fileRef: 'Binder, tab 3' })).ok === true);
  ok('only the stored keys come out (nothing smuggled)', Object.keys(C.clean(Object.assign({}, base, { policyNumber: 'X1' })).doc).sort().join() === 'active,expiry,fileRef,issuer,name,notes,type');

  console.log('E. the roll-up (Home strip + Settings list)');
  const docs = [
    { id: 'a', type: 'gl_coi', name: 'GL', expiry: addDays(T, 20) },
    { id: 'b', type: 'license', name: 'License', expiry: addDays(T, -3) },
    { id: 'c', type: 'vehicle', name: 'Truck', expiry: addDays(T, 5) },
    { id: 'd', type: 'other', name: 'Old', expiry: addDays(T, -100), active: false },
    { id: 'e', type: 'workers_comp', name: 'Comp', expiry: addDays(T, 200) },
    { id: 'f', type: 'other', name: 'Undated', expiry: '' },
  ];
  const sum = C.summarize(docs, T);
  ok('worst first: expired, then 5 days, then 20 days', sum.rows.slice(0, 3).map((r) => r.id).join() === 'b,c,a');
  ok('an inactive (history) row never warns and is not listed', !sum.rows.some((r) => r.id === 'd'));
  ok('attention = the expired one and the two soon ones, not the far-off or undated', sum.attention.map((r) => r.id).join() === 'b,c,a');
  ok('worst = 4 (expired); expired 1, soon 2, undated 1', sum.worst === 4 && sum.expired === 1 && sum.soon === 2 && sum.noDate === 1);
  ok('positive control: all far-off docs raise nothing', C.summarize([docs[4]], T).attention.length === 0 && C.summarize([docs[4]], T).worst === 0);
  ok('an empty list is safe', C.summarize([], T).rows.length === 0 && C.summarize(null, T).worst === 0);

  console.log('F. the alert plan: one report per stage, de-duplicated, owner only');
  const gl = { id: 'abc123', type: 'gl_coi', name: 'GL certificate', issuer: 'Sample Insurance Co', expiry: '2026-11-17' };
  const idOn = (offset) => { const a = S.alertFor('co-a', gl, addDays('2026-11-17', -offset)); return a && a.id; };
  ok('31 days out: nothing', idOn(31) === null);
  ok('30 days out: a due30 report', /_due30$/.test(idOn(30)));
  ok('the same stage on the next day has the SAME id (so create() skips it: no daily repeat)', idOn(30) === idOn(29) && idOn(29) === idOn(15));
  ok('14 days out: a due14 report with a different id', /_due14$/.test(idOn(14)) && idOn(14) !== idOn(15));
  ok('7 days out: due7; the days between 14 and 8 keep the due14 id', /_due7$/.test(idOn(7)) && idOn(14) === idOn(8));
  ok('expired: its own id, the same every day after', /_expired$/.test(idOn(-1)) && idOn(-1) === idOn(-30));
  ok('a sweep that missed days files only the stage the doc is in NOW (never the passed ones)', S.planAlerts('co-a', [gl], addDays('2026-11-17', -3)).length === 1);
  const renewed = Object.assign({}, gl, { expiry: '2027-11-17' });
  ok('renewing (a new expiry date) starts a fresh id set', S.alertFor('co-a', Object.assign({}, gl, { expiry: '2026-11-17' }), '2026-11-10').id !== S.alertFor('co-a', renewed, '2027-11-10').id);
  ok('an inactive doc files nothing', S.alertFor('co-a', Object.assign({}, gl, { active: false }), '2026-11-10') === null);
  ok('a doc with no date files nothing', S.alertFor('co-a', Object.assign({}, gl, { expiry: '' }), '2026-11-10') === null);
  ok('ids differ per company (cross-tenant ids cannot collide)', S.alertFor('co-a', gl, '2026-11-10').id !== S.alertFor('co-b', gl, '2026-11-10').id);
  const rep = S.alertFor('co-a', gl, '2026-11-10');
  ok('the item is a plain report: no lead, no customer, no phone, no email, no draft kind', rep.item.kind === 'report' && rep.item.leadId === null && !/draft|phone|email_to|sms/i.test(JSON.stringify(rep.item)));
  ok('the wording names the doc and the date, and says how to stop the reminders', /GL certificate/.test(rep.item.title) && /Nov 17, 2026/.test(rep.item.text) && /update the expiry date/.test(rep.item.text));
  ok('the report carries no policy-number style data (only name, kind, issuer)', !/policy|account/i.test(rep.item.text.replace(/Renew it and update the expiry date in Settings > Company Profile > Company documents/, '')));

  console.log('G. the sweep: dry-run by default, live only behind the flag, once per stage');
  const W = require(path.join(ROOT, 'functions/company-doc-expiry.js'));
  function fakeDb(seed) {
    const store = Object.assign({}, seed.docs);
    const created = new Map(), sets = new Map();
    return {
      created, sets,
      collectionGroup: (name) => ({ limit: () => ({ get: async () => ({ forEach: (fn) => Object.keys(store).filter((p) => p.includes('/' + name + '/')).forEach((p) => fn({ ref: { path: p }, data: () => store[p] })) }) }) }),
      doc: (p) => ({
        get: async () => ({ exists: p in (seed.other || {}), data: () => (seed.other || {})[p] }),
        create: async (v) => { if (created.has(p)) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } created.set(p, v); },
        set: async (v) => { sets.set(p, v); },
      }),
    };
  }
  const NOW = Date.parse('2026-11-10T14:00:00Z');   // 09:00 Eastern; the GL cert expires in 7 days
  const seed = { docs: { 'companies/co-a/companyDocs/abc123': gl, 'companies/co-a/companyDocs/far': { type: 'other', name: 'Far', expiry: '2030-01-01' }, 'companies/co-b/companyDocs/zzz': { type: 'license', name: 'Other tenant license', expiry: '2026-11-12' } }, other: { 'companies/co-a': { ownerId: 'owner-uid' } } };
  const dry = fakeDb(seed);
  const rDry = await W.runWatch({ db: dry, nowMs: NOW, live: false });
  ok('dry-run counts what is due (2: the GL cert and the other tenant\'s license) and writes NOTHING', rDry.due === 2 && rDry.filed === 0 && dry.created.size === 0 && dry.sets.size === 0, JSON.stringify(rDry));
  const live = fakeDb(seed);
  const r1 = await W.runWatch({ db: live, nowMs: NOW, live: true });
  ok('live: files one report per due doc, each under its own company', r1.filed === 2 && live.created.size === 2 && [...live.created.values()].map((v) => v.companyId).sort().join() === 'co-a,co-b', JSON.stringify(r1));
  const first = [...live.created.values()][0];
  ok('each report is pending, unverified, from the Document watch, kind report', first.status === 'pending' && first.verified === false && first.botId === 'doc-watch' && first.kind === 'report');
  const r2 = await W.runWatch({ db: live, nowMs: NOW + 3600000, live: true });
  ok('the same day again: nothing new is filed (2 already filed)', r2.filed === 0 && r2.alreadyFiled === 2 && live.created.size === 2, JSON.stringify(r2));
  const r3 = await W.runWatch({ db: live, nowMs: NOW + 86400000, live: true });
  ok('the next day, same stage: still nothing new', r3.filed === 0 && live.created.size === 2, JSON.stringify(r3));
  ok('one bell per company, to the company doc\'s ownerId (else the company id)', live.sets.get('notifications/docexp_co-a_2026-11-10').userId === 'owner-uid' && live.sets.get('notifications/docexp_co-b_2026-11-10').userId === 'co-b');
  const r4 = await W.runWatch({ db: live, nowMs: Date.parse('2026-11-18T14:00:00Z'), live: true });
  ok('the day after the GL cert expires, a new "expired" report is filed (once)', r4.filed >= 1 && [...live.created.keys()].some((k) => /abc123_2026-11-17_expired$/.test(k)), JSON.stringify(r4));
  ok('the dry-run flag is read from COMPANY_DOC_EXPIRY_ENABLED, default off', /COMPANY_DOC_EXPIRY_ENABLED === 'true'/.test(read('functions/company-doc-expiry.js')) && /COMPANY_DOC_EXPIRY_ENABLED=false/.test(read('functions/.env.nobigdeal-pro')));
  ok('exported from index.js and listed in FUNCTIONS_INDEX.md', /exports\.companyDocExpiryWatch = require\('\.\/company-doc-expiry'\)\.companyDocExpiryWatch;/.test(read('functions/index.js')) && /\| `companyDocExpiryWatch` \|/.test(read('functions/FUNCTIONS_INDEX.md')));
  const src = read('functions/company-doc-expiry.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the sweep file never touches SMS, email, Resend or Twilio', !/twilio|resend|sendEmail|sms_log|mail\//i.test(src));

  console.log('H. wiring');
  const loader = read('docs/pro/js/script-loader.js');
  ok('the bundle loads the logic before the UI', /companydocs: \[\s*'css\/company-docs\.css\?v=1',\s*'js\/company-docs-logic\.js\?v=1',\s*'js\/company-docs-ui\.js\?v=1'\s*\]/.test(loader));
  ok('opening Settings loads it too', /settings:\s+\['theme', 'tenantsettings', 'companydocs'\]/.test(loader));
  ok('Home boot kicks the bundle', /loadBundle\('companydocs'\)/.test(read('docs/pro/js/today-home.js')));
  const html = read('docs/pro/dashboard.html');
  ok('the Home slot and the Settings mount exist exactly once', (html.match(/id="homeDocExpiry"/g) || []).length === 1 && (html.match(/id="companyDocsMount"/g) || []).length === 1);
  const ui = read('docs/pro/js/company-docs-ui.js');
  ok('the UI uses no inline handlers and no storage links', !/\son[a-z]+=/i.test(ui.replace(/\/\*[\s\S]*?\*\//g, '')) && !/getDownloadURL|\?token=/.test(ui));

  console.log('I. the screens render what the roles allow (the real UI file in a stub DOM)');
  const vm = require('vm');
  function mountUi(claims, docsRows) {
    const els = { companyDocsMount: { id: 'companyDocsMount', innerHTML: '', firstChild: null }, homeDocExpiry: { id: 'homeDocExpiry', innerHTML: '', firstChild: null, hidden: true } };
    const win = { NBDCompanyDocsLogic: C, _userClaims: claims, _user: { uid: claims.uid || 'u1' }, db: {}, collection: () => ({}), getDocs: async () => ({ forEach: (fn) => docsRows.forEach((r) => fn({ id: r.id, data: () => r })) }), setTimeout, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: (f) => f() };
    win.window = win;
    const document = { readyState: 'complete', hidden: false, body: {}, addEventListener() {}, getElementById: (id) => els[id] || null };
    win.document = document;
    vm.runInNewContext(read('docs/pro/js/company-docs-ui.js'), Object.assign(win, { document, MutationObserver: function () { this.observe = () => {}; }, console }));
    return { win, els };
  }
  const soon = [{ id: 'a', type: 'gl_coi', name: 'GL <b>cert</b>', issuer: 'Ins "Co"', expiry: addDays(C.localYmd(), 10), fileRef: 'Binder tab 3' }, { id: 'b', type: 'license', name: 'Fine', expiry: addDays(C.localYmd(), 300) }];
  const owner = mountUi({}, soon);
  await owner.win.NBDCompanyDocs.load(true);
  ok('owner: the Home strip shows the soon document with its badge', /Company documents/.test(owner.els.homeDocExpiry.innerHTML) && /Expires in 10 days/.test(owner.els.homeDocExpiry.innerHTML) && owner.els.homeDocExpiry.hidden === false);
  ok('owner: the far-off document is not on the Home strip', !/Fine/.test(owner.els.homeDocExpiry.innerHTML));
  ok('owner: the Settings card has Add / Edit / Remove', /data-cd-act="save"/.test(owner.els.companyDocsMount.innerHTML) && /data-cd-act="edit"/.test(owner.els.companyDocsMount.innerHTML) && /data-cd-act="remove"/.test(owner.els.companyDocsMount.innerHTML));
  ok('names and issuers are escaped (no live tag, no raw quote)', !/<b>cert<\/b>/.test(owner.els.companyDocsMount.innerHTML) && /GL &lt;b&gt;cert&lt;\/b&gt;/.test(owner.els.companyDocsMount.innerHTML) && /Ins &quot;Co&quot;/.test(owner.els.companyDocsMount.innerHTML));
  ok('the file reference is shown as text, never as a link', /Where it lives: Binder tab 3/.test(owner.els.companyDocsMount.innerHTML) && !/<a /.test(owner.els.companyDocsMount.innerHTML));
  const viewer = mountUi({ role: 'viewer', companyId: 'co-a', uid: 'vic' }, soon);
  await viewer.win.NBDCompanyDocs.load(true);
  ok('viewer: sees the list and the Home strip, but no Add / Edit / Remove', /Expires in 10 days/.test(viewer.els.companyDocsMount.innerHTML) && !/data-cd-act="(save|edit|remove)"/.test(viewer.els.companyDocsMount.innerHTML) && /Only the owner and company admins/.test(viewer.els.companyDocsMount.innerHTML));
  const viewerOwnerUi = mountUi({ role: 'viewer', companyId: 'co-v', uid: 'co-v' }, soon);
  await viewerOwnerUi.win.NBDCompanyDocs.load(true);
  ok('a viewer whose uid IS the company id still gets no Add / Edit / Remove (the rules deny them too)', /Expires in 10 days/.test(viewerOwnerUi.els.companyDocsMount.innerHTML) && !/data-cd-act="(save|edit|remove)"/.test(viewerOwnerUi.els.companyDocsMount.innerHTML));
  const adminUi = mountUi({ role: 'company_admin', companyId: 'co-a', uid: 'carol' }, soon);
  await adminUi.win.NBDCompanyDocs.load(true);
  ok('a company_admin gets Add / Edit / Remove', /data-cd-act="save"/.test(adminUi.els.companyDocsMount.innerHTML));
  const repUi =mountUi({ role: 'sales_rep', companyId: 'co-a', uid: 'alice' }, soon);
  await repUi.win.NBDCompanyDocs.load(true);
  ok('sales rep: nothing on either screen (the rules do not let them read it)', repUi.els.companyDocsMount.innerHTML === '' && repUi.els.homeDocExpiry.innerHTML === '');
  const quiet = mountUi({}, [soon[1]]);
  await quiet.win.NBDCompanyDocs.load(true);
  ok('positive control: only far-off documents = the Home strip stays empty and hidden', quiet.els.homeDocExpiry.innerHTML === '' && quiet.els.homeDocExpiry.hidden === true);
  const gone = mountUi({}, [{ id: 'x', type: 'license', name: 'Lapsed license', expiry: addDays(C.localYmd(), -2) }]);
  await gone.win.NBDCompanyDocs.load(true);
  ok('an expired document turns the Home strip to "has expired"', /has expired/.test(gone.els.homeDocExpiry.innerHTML) && /cd-home-bad/.test(gone.els.homeDocExpiry.innerHTML));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
