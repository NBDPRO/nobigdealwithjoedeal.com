/**
 * tests/inspect-short-form-2026-10-06.test.js
 *
 * /inspect shorter form + choice-matched thank-you (Jo, 2026-10-06; CRO
 * review findings #2 and #3).
 *
 *   1. The FORM asks name, address, mobile, the REQUIRED scheduling choice and
 *      the consent box. Nothing else. The consent sentence is untouched.
 *   2. Email, "What happened?", referral code, photos, best time, insurance and
 *      how heard live on the THANK-YOU screen (#insDetails), optional, saved
 *      onto the SAME lead through updatePublicLeadIntake (the /estimate #2133
 *      path) with the one-time grant the submit asks for (wantsFollowUp).
 *   3. The thank-you headline follows the choice: calendar → "Pick your time"
 *      + a plain Pick My Time link, never a popup; contact me → "Joe will reach
 *      out, usually the same day".
 *   4. Server: the three free-text extras are accepted for an inspect_leads
 *      grant only, sanitised, fill-only on the CRM card; submitPublicLead's
 *      inspect contract (required fields, phoneDigits on the bridge) holds.
 *
 * Behaviour is EXECUTED (vm-sandboxed browser files with a stub DOM; the
 * server save against a fake Firestore). Zero deps beyond functions/.
 * Run: node tests/inspect-short-form-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : '')); }
}

const HTML = read('docs/inspect.html');
const FORM = (/<form id="inspectForm"[\s\S]*?<\/form>/.exec(HTML) || [''])[0];
const SUCCESS = (/<div class="form-success" id="inspectSuccess">[\s\S]*?<div id="insIntakeAfter"><\/div>/.exec(HTML) || [''])[0];

(async () => {
  console.log('1. the form: five things, nothing else');
  {
    const ids = [...FORM.matchAll(/<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    ok('the form exists', FORM.length > 0);
    ok('visible inputs are exactly name, address, phone, consent (+ hidden UTMs + honeypot)',
      JSON.stringify(ids.filter((i) => !/^utm_/.test(i) && i !== 'f-nbd-hp')) === JSON.stringify(['f-name', 'f-address', 'f-phone', 'ins-consent']), ids);
    ok('name, address and phone stay required', ['f-name', 'f-address', 'f-phone'].every((id) => new RegExp('id="' + id + '"[^>]*required').test(FORM)));
    ok('the intake block on the form is the scheduling choice only', /<div data-nbd-intake="ins" data-extras="false" data-cal-hint="Pick your time on the next screen\."><\/div>/.test(FORM));
    ok('no email / story / referral / photo field on the form', !/f-email|f-story|f-referral|Photos/.test(FORM.replace(/<!--[\s\S]*?-->/g, '')));
    ok('the consent sentence is byte-for-byte the live one (#2225 owns its change)', FORM.includes('<label class="sc-consent"><input type="checkbox" id="ins-consent"><span>I agree to receive my results and follow-up communication from No Big Deal Home Solutions by call or text at the number above. Message frequency varies. Message &amp; data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. <a href="/privacy#sms-terms">Privacy Policy</a> &middot; <a href="/terms">Terms</a></span></label>'));
    ok('the box is not pre-checked', !/id="ins-consent"[^>]*checked/.test(FORM));
    ok('the walk-it line is on the page', HTML.includes('You don&rsquo;t have to be home, but you&rsquo;re welcome to walk it with Joe.'));
    ok('the moved fields live on the thank-you screen', /id="insDetails" hidden/.test(SUCCESS) && ['f-story', 'f-email', 'f-referral', 'insXIntake', 'insDetailsSave', 'insDetailsStatus'].every((id) => SUCCESS.includes('id="' + id + '"')));
    ok('the default thank-you headline is the same-day one (no "within 24 hours" there)', /<h3 id="insThanksTitle">Joe will reach out, usually the same day<\/h3>/.test(SUCCESS) && !/24 hours|within the hour/.test(SUCCESS));
    ok('Pick My Time is a plain link, hidden until a calendar choice', /<a class="ins-pick-time" id="insPickTime" href="https:\/\/cal\.com\/nobigdeal\/roof-inspection" target="_blank" rel="noopener" hidden>Pick My Time<\/a>/.test(SUCCESS) && /\.ins-pick-time\[hidden\]\{display:none\}/.test(HTML));
    ok('no inline handlers', !/\son[a-z]+=/i.test(FORM + SUCCESS));
    ok('cache-busters bumped', /intake-extras\.js\?v=4/.test(HTML) && /inspect-form\.js\?v=4/.test(HTML));
  }

  console.log('\n2. intake-extras: the block splits in two, the popup is opt-out');
  const IE = read('docs/assets/js/intake-extras.js');
  function loadIntake() {
    const opened = [];
    const mk = () => { const e = { _html: '', children: [], appendChild(c) { this.children.push(c); return c; }, querySelector: () => null, setAttribute() {} }; Object.defineProperty(e, 'innerHTML', { get() { return this._html; }, set(v) { this._html = String(v); } }); return e; };
    const window = { open: (u) => { opened.push(u); return null; } };
    const document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, addEventListener() {}, createElement: mk, head: { appendChild() {} } };
    vm.runInNewContext(IE, { window, document, URLSearchParams, console });
    return { NBD: window.NBDIntake, opened, mk };
  }
  {
    const { NBD, opened, mk } = loadIntake();
    const form = NBD.html('ins', { extras: false });
    const thanks = NBD.html('insX', { sched: false });
    const full = NBD.html('hp');
    ok('extras:false → the scheduling choice and nothing else', /insScheduling/.test(form) && /value="calendar"/.test(form) && !/Photos|BestTime|Insurance|HowHeard/.test(form));
    ok('sched:false → photos, best time, insurance, how heard and no scheduling radios', !/Scheduling/.test(thanks) && /insXPhotos/.test(thanks) && /insXBestTime/.test(thanks) && /insXInsurance/.test(thanks) && /insXHowHeard/.test(thanks));
    ok('every other page still gets the whole block (default unchanged)', /hpScheduling/.test(full) && /hpPhotos/.test(full) && /hpBestTime/.test(full));
    ok('/inspect only: calHint rewords the calendar helper (escaped); the default stays for the other forms',
      /Pick your time on the next screen\./.test(NBD.html('ins', { extras: false, calHint: 'Pick your time on the next screen.' }))
      && /&lt;b&gt;/.test(NBD.html('z', { calHint: '<b>' }))
      && /The calendar opens right after you send this\./.test(full) && !/next screen/.test(full));
    ok('the static mount honours data-cal-hint', /if \(el\.hasAttribute\('data-cal-hint'\)\) opts\.calHint = el\.getAttribute\('data-cal-hint'\);/.test(IE));
    ok('the static mount honours data-extras="false"', /if \(el\.getAttribute\('data-extras'\) === 'false'\) opts\.extras = false;/.test(IE));

    let box = mk();
    await NBD.afterSubmit(box, { ownCalendar: true, fields: { scheduling: 'calendar' }, files: [] });
    ok('ownCalendar → no popup and no second calendar button', opened.length === 0 && !/nbd-intake-cal/.test(box.children[0]._html), box.children[0]._html);
    box = mk();
    await NBD.afterSubmit(box, { fields: { scheduling: 'calendar' }, files: [] });
    ok('without it (the other forms) the calendar button + popup behave as before', opened.length === 1 && /nbd-intake-cal/.test(box.children[0]._html));
  }

  console.log('\n3. inspect-form.js, executed: submit, thank-you, add details');
  const JS = read('docs/assets/js/inspect-form.js');
  function runInspect({ scheduling, response, photoToken }) {
    const els = {}; const calls = []; const fetches = []; const opened = []; const handlers = {};
    const mk = (id, props) => {
      const el = Object.assign({ id, value: '', attrs: {}, textContent: '', disabled: false, hidden: false, style: {}, className: '', childElementCount: 0,
        classList: { add() {} }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
        focus() {}, remove() {}, scrollIntoView() {}, addEventListener(t, fn) { handlers[id + ':' + t] = fn; }, appendChild() {}, querySelector: () => null }, props || {});
      els[id] = el; return el;
    };
    const form = mk('inspectForm', { fields: () => ({ name: 'Pat Example', address: '12 Elm St, Goshen OH', phone: '8595550100', nbd_hp: '' }) });
    mk('f-name', { value: 'Pat Example' }); mk('f-address', { value: '12 Elm St, Goshen OH' }); mk('f-phone', { value: '8595550100' });
    mk('ins-consent', { checked: true }); mk('inspectSubmit'); mk('inspectSuccess');
    mk('insThanksTitle', { textContent: 'Joe will reach out, usually the same day' }); mk('insThanksText', { textContent: 'default' });
    mk('insPickTime', { hidden: true, attrs: { href: 'https://cal.com/nobigdeal/roof-inspection' } });
    mk('insDetails', { hidden: true }); mk('insDetailsSave'); mk('insDetailsStatus'); mk('insIntakeAfter');
    mk('f-story'); mk('f-email'); mk('f-referral');
    const box = mk('insXIntake');
    Object.defineProperty(box, 'innerHTML', { set(v) { this._html = v; this.childElementCount = 1; }, get() { return this._html; } });
    const NBDIntake = {
      read: (root, p) => (p === 'ins' ? { fields: { scheduling }, files: [] } : { fields: { bestTime: 'Evening' }, files: [] }),
      html: (p, o) => 'block:' + p + ':' + JSON.stringify(o),
      calendarUrl: (i) => 'https://cal.com/nobigdeal/roof-inspection?name=' + encodeURIComponent(i.name),
      afterSubmit: () => {},
    };
    function FormData(f) { this._f = f.fields(); }
    FormData.prototype.forEach = function (cb) { Object.keys(this._f).forEach((k) => cb(this._f[k], k)); };
    const window = {
      location: { search: '' }, NBDIntake, open: (u) => { opened.push(u); },
      nbdPublicFunctionsBase: () => 'https://fn.test',
      submitPublicLead: (kind, data) => { calls.push({ kind, data }); return Promise.resolve(response || { ok: true, photoToken: photoToken === undefined ? 'a'.repeat(48) : photoToken }); },
    };
    const fetch = async (url, init) => { fetches.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
    const document = { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => mk('__n' + Object.keys(els).length), addEventListener() {} };
    form.addEventListener = (t, fn) => { handlers['form:' + t] = fn; };
    vm.runInNewContext(JS, { window, document, FormData, URLSearchParams, fetch, Promise, console: { error() {}, warn() {}, log() {} } });
    handlers['form:submit']({ preventDefault() {} });
    return { els, calls, fetches, opened, handlers };
  }
  const tick = () => new Promise((r) => setImmediate(r));
  {
    const r = runInspect({ scheduling: 'calendar' });
    await tick(); await tick();
    const d = (r.calls[0] || {}).data || {};
    ok('the submit posts the first-screen fields + the scheduling choice + consent', r.calls.length === 1 && d.name && d.address && d.phone && d.scheduling === 'calendar' && d.tcpaConsent === true && d.source === '/inspect', d);
    ok('...asks for the follow-up grant (wantsFollowUp)', d.wantsFollowUp === true);
    ok('...and carries no story / email / referral', !('story' in d) && !('email' in d) && !('referralCode' in d));
    ok('calendar → headline "Pick your time"', r.els.insThanksTitle.textContent === 'Pick your time');
    ok('...Pick My Time shown, prefilled, as a link (no window.open)', r.els.insPickTime.hidden === false && /^https:\/\/cal\.com\/nobigdeal\/roof-inspection\?name=Pat/.test(r.els.insPickTime.attrs.href) && r.opened.length === 0, r.els.insPickTime);
    ok('...and the add-details step is mounted without a scheduling question', r.els.insDetails.hidden === false && r.els.insXIntake._html === 'block:insX:{"sched":false}');

    r.els['f-story'].value = 'Shingles off after the storm';
    r.els['f-email'].value = 'pat@example.com';
    r.els['f-referral'].value = 'john-ab12';
    r.handlers['insDetailsSave:click']();
    await tick(); await tick();
    const f = r.fetches[0] || {};
    ok('Send to Joe posts to updatePublicLeadIntake with the grant', r.fetches.length === 1 && f.url === 'https://fn.test/updatePublicLeadIntake' && f.body.token === 'a'.repeat(48), r.fetches);
    ok('...carrying story, email, referral code and the intake answers', f.body && f.body.story === 'Shingles off after the storm' && f.body.email === 'pat@example.com' && f.body.referralCode === 'john-ab12' && f.body.bestTime === 'Evening', f.body);
    ok('...and says it saved', /on your request now/.test(r.els.insDetailsStatus.textContent));
  }
  {
    const r = runInspect({ scheduling: 'contact_me' });
    await tick(); await tick();
    ok('contact me → the same-day headline stays, Pick My Time stays hidden', r.els.insThanksTitle.textContent === 'Joe will reach out, usually the same day' && r.els.insPickTime.hidden === true);
    r.els['f-email'].value = 'not-an-email';
    await r.handlers['insDetailsSave:click']();
    ok('a bad email is refused in the page, nothing posted', r.fetches.length === 0 && /email/.test(r.els.insDetailsStatus.textContent));
  }
  {
    const r = runInspect({ scheduling: 'contact_me', photoToken: null });
    await tick(); await tick();
    ok('no grant came back → the add-details step stays hidden (nothing to save against)', r.els.insDetails.hidden === true && !r.handlers['insDetailsSave:click']);
  }

  console.log('\n4. server: the extras, inspect_leads only, fill-only on the card');
  {
    const SPEC = require(path.join(ROOT, 'functions', 'public-lead-intake-spec.js'));
    const x = SPEC.sanitizeFollowUpExtras({ story: '  <b>leak</b> over the porch ', email: 'pat@example.com', referralCode: ' john-ab12!', leadScore: '99' });
    ok('extras are sanitised: < > dropped, code normalised like the bridge, foreign keys dropped', x.story === 'bleak/b over the porch' && x.email === 'pat@example.com' && x.referralCode === 'JOHN-AB12' && !('leadScore' in x), x);
    ok('a bad email and an over-cap story are dropped', JSON.stringify(SPEC.sanitizeFollowUpExtras({ email: 'nope', story: 'x'.repeat(1501) })) === '{}');
    ok('the submit-path allowlist is unchanged (extras are follow-up only)', JSON.stringify(SPEC.INTAKE_OPTIONAL) === JSON.stringify(['scheduling', 'bestTime', 'insuranceClaim', 'howHeard']));

    const PLP = require(path.join(ROOT, 'functions', 'public-lead-photos.js'))._internal;
    const B = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));
    function fakeDb(seed) {
      const store = new Map(Object.entries(seed || {}));
      const apply = (prev, patch) => { const out = Object.assign({}, prev || {}); for (const [k, v] of Object.entries(patch)) { if (v && typeof v === 'object' && 'operand' in v) out[k] = (out[k] || 0) + v.operand; else out[k] = v; } return out; };
      const ref = (c, id) => { const key = c + '/' + id; return {
        get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
        set: async (d, o) => { store.set(key, o && o.merge ? apply(store.get(key), d) : apply({}, d)); },
        update: async (d) => { if (!store.has(key)) throw new Error('NOT_FOUND'); store.set(key, apply(store.get(key), d)); },
      }; };
      return { store, collection: (c) => ({ doc: (id) => ref(c, id) }), runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => r.update(d) }) };
    }
    const TOKEN = 'c'.repeat(48);
    const GKEY = PLP.GRANTS + '/' + PLP.hashToken(TOKEN);
    const grant = (collection) => ({ collection, publicId: 'pub-9', exp: Date.now() + 60_000, max: 10, used: 0 });
    const crmKey = 'leads/' + B.bridgeDocId('inspect_leads', 'pub-9');

    let db = fakeDb({ [GKEY]: grant('inspect_leads'), 'inspect_leads/pub-9': { name: 'Pat', phone: '8595550100' }, [crmKey]: { notes: '', email: '', phoneDigits: '8595550100' } });
    let out = await PLP.saveIntakeUpdate(db, { token: TOKEN, story: 'Leak over the porch', email: 'pat@example.com', referralCode: 'john-ab12', bestTime: 'Evening' });
    const pub = db.store.get('inspect_leads/pub-9');
    const crm = db.store.get(crmKey);
    ok('an inspect grant saves story / email / referral (200, CRM updated)', out.status === 200 && out.json.crm === true, out);
    ok('...onto the same public lead, under the submit-time keys', pub.story === 'Leak over the porch' && pub.email === 'pat@example.com' && pub.referralCode === 'JOHN-AB12' && pub.bestTime === 'Evening' && pub.phone === '8595550100');
    ok('...and the CRM card gets note lines, the email and the referral code', /What happened: Leak over the porch/.test(crm.notes) && /Email: pat@example\.com/.test(crm.notes) && crm.email === 'pat@example.com' && crm.redeemReferralCode === 'JOHN-AB12');
    ok('...phone and phoneDigits on the card are untouched', crm.phoneDigits === '8595550100' && !('phone' in crm));

    db = fakeDb({ [GKEY]: grant('inspect_leads'), 'inspect_leads/pub-9': {}, [crmKey]: { notes: 'x', email: 'rep-typed@example.com', redeemReferralCode: 'OLD-1' } });
    await PLP.saveIntakeUpdate(db, { token: TOKEN, email: 'pat@example.com', referralCode: 'NEW-2' });
    ok('fill-only: an email or referral code already on the card is never overwritten', db.store.get(crmKey).email === 'rep-typed@example.com' && db.store.get(crmKey).redeemReferralCode === 'OLD-1');

    db = fakeDb({ [GKEY]: grant('estimate_leads'), 'estimate_leads/pub-9': {} });
    out = await PLP.saveIntakeUpdate(db, { token: TOKEN, story: 'hello', email: 'pat@example.com' });
    ok('a non-inspect grant with only extras → 400, and the grant is NOT spent', out.status === 400 && !db.store.get(GKEY).intakeUpdates, out);
    db = fakeDb({ [GKEY]: grant('estimate_leads'), 'estimate_leads/pub-9': {} });
    out = await PLP.saveIntakeUpdate(db, { token: TOKEN, story: 'hello', bestTime: 'Evening' });
    ok('...with a real answer too → saved, extras dropped', out.status === 200 && db.store.get('estimate_leads/pub-9').bestTime === 'Evening' && !('story' in db.store.get('estimate_leads/pub-9')));

    const GW = read('functions/handlers/integrations.js');
    const block = GW.slice(GW.indexOf('  inspect: {'), GW.indexOf('};', GW.indexOf('  inspect: {')));
    ok('intake contract: the inspect kind still requires name, phone, address, source', /required: \['name', 'phone', 'address', 'source'\]/.test(block));
    const mapped = B.mapPublicLeadToLead({ collection: 'inspect_leads', data: { name: 'Pat Example', phone: '+1 (859) 555-0100', address: '12 Elm St', source: '/inspect', scheduling: 'calendar' }, ownerUid: 'u', companyId: 'c' });
    ok('...and the bridged CRM lead still stamps phoneDigits', mapped.phoneDigits === '8595550100', mapped.phoneDigits);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
