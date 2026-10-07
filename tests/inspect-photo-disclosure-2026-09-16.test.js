/**
 * tests/inspect-photo-disclosure-2026-09-16.test.js
 *
 * ORIGINAL (2026-09-16): /inspect's photo input never sent the files, only
 * their count and names, and the success panel said nothing, so a homeowner
 * believed Joe had their pictures. The fix then was a "photos were not sent,
 * text them" line.
 *
 * SUPERSEDED (2026-09-30, intake-forms overhaul): photos are now really
 * sent. The gateway returns a one-time photoToken and NBDIntake.afterSubmit
 * uploads each photo to uploadPublicLeadPhoto. The invariant this file has
 * always guarded is kept, now tested on BEHAVIOUR (vm-sandboxed
 * intake-extras.js with a stub DOM + fetch): the homeowner is never told
 * photos arrived when they did not.
 *   - every upload OK      → "✓ N photos attached"
 *   - an upload fails      → says how many did not upload + the text-us line
 *   - no photoToken        → "could not be attached" + the text-us line
 *   - no photos chosen     → no photo line at all
 *
 * Zero deps. Run: node tests/inspect-photo-disclosure-2026-09-16.test.js
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
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('inspect / intake — never claim photos arrived when they did not\n');

const SRC = read('docs/assets/js/intake-extras.js');
const JS = read('docs/assets/js/inspect-form.js');
const HTML = read('docs/inspect.html');

// Minimal DOM: afterSubmit builds one wrapper, sets innerHTML, then finds the
// status line by attribute and updates textContent/innerHTML.
function makeSandbox(fetchImpl) {
  const opened = [];
  function el() {
    const e = { _html: '', textContent: '', className: '', children: [], status: null };
    Object.defineProperty(e, 'innerHTML', {
      get() { return this._html; },
      set(v) { this._html = String(v); if (/data-nbd-photo-status/.test(v)) this.status = el(); },
    });
    e.appendChild = (c) => { e.children.push(c); return c; };
    e.querySelector = (sel) => (sel === '[data-nbd-photo-status]' ? e.status : null);
    return e;
  }
  const document = {
    readyState: 'complete', createElement: () => el(),
    querySelectorAll: () => [], addEventListener() {}, getElementById: () => null,
    querySelector: () => null,
  };
  document.head = { appendChild() {} };
  const baseCreate = document.createElement;
  document.createElement = (tag) => Object.assign(baseCreate(tag), { setAttribute() {} });
  class FakeImage { set src(_) { setTimeout(() => this.onerror && this.onerror(), 0); } }
  class FakeReader { readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; setTimeout(() => this.onload(), 0); } }
  const window = { nbdPublicFunctionsBase: () => 'https://fn.test', open: (u) => opened.push(u) };
  const ctx = {
    window, document, Image: FakeImage, FileReader: FakeReader,
    URL: Object.assign(function () {}, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
    URLSearchParams, fetch: fetchImpl, setTimeout, Promise, console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'intake-extras.js' });
  return { NBD: window.NBDIntake, opened, el };
}

const resp = (okFlag, body) => ({ ok: okFlag, json: async () => body || {} });
const statusText = (box) => { const w = box.children[0]; const s = w && w.status; return s ? (s._html || s.textContent) : '(no photo line)'; };

(async () => {
  // 1. All uploads succeed.
  {
    const calls = [];
    const S = makeSandbox(async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return resp(true, { success: true }); });
    const box = S.el();
    await S.NBD.afterSubmit(box, { prefix: 'ins', quietContact: true, fields: { scheduling: 'contact_me' }, files: [{ name: 'a.jpg' }, { name: 'b.jpg' }], photoToken: 't'.repeat(48) });
    ok('every photo is POSTed to uploadPublicLeadPhoto with the one-time token', calls.length === 2 && calls.every((c) => c.url === 'https://fn.test/uploadPublicLeadPhoto' && c.body.token === 't'.repeat(48) && /^data:image\//.test(c.body.dataUrl)), JSON.stringify(calls.map((c) => c.url)));
    ok('success says exactly how many photos were attached', /✓ 2 photos attached/.test(statusText(box)), statusText(box));
  }
  // 2. One upload fails.
  {
    let n = 0;
    const S = makeSandbox(async () => (++n === 2 ? resp(false, { error: 'That photo is too large (8 MB max).' }) : resp(true)));
    const box = S.el();
    await S.NBD.afterSubmit(box, { prefix: 'ins', fields: { scheduling: 'contact_me' }, files: [{ name: 'a.jpg' }, { name: 'b.jpg' }], photoToken: 't'.repeat(48) });
    const t = statusText(box);
    ok('a failed upload is disclosed, never reported as attached', /1 photo attached; 1 did not upload/.test(t) && !/✓/.test(t), t);
    ok('…and points the homeowner to texting the photos', /text/i.test(t) && /420-7382/.test(t), t);
  }
  // 3. A network error on every upload.
  {
    const S = makeSandbox(async () => { throw new Error('offline'); });
    const box = S.el();
    await S.NBD.afterSubmit(box, { fields: { scheduling: 'contact_me' }, files: [{ name: 'a.jpg' }], photoToken: 't'.repeat(48) });
    ok('a network failure is disclosed with the text-us line', /did not upload/.test(statusText(box)) && /420-7382/.test(statusText(box)), statusText(box));
  }
  // 4. No token came back (old gateway, mint failure).
  {
    const calls = [];
    const S = makeSandbox(async (u) => { calls.push(u); return resp(true); });
    const box = S.el();
    await S.NBD.afterSubmit(box, { fields: { scheduling: 'contact_me' }, files: [{ name: 'a.jpg' }], photoToken: null });
    ok('no photoToken → nothing is uploaded and the homeowner is told the photos were not attached', calls.length === 0 && /could not be attached/.test(statusText(box)) && /420-7382/.test(statusText(box)), statusText(box));
  }
  // 5. No photos chosen — the common case.
  {
    const S = makeSandbox(async () => resp(true));
    const box = S.el();
    await S.NBD.afterSubmit(box, { fields: { scheduling: 'contact_me' }, files: [], photoToken: null });
    ok('no photos chosen → no photo line at all', statusText(box) === '(no photo line)', statusText(box));
  }

  // Wiring on /inspect.
  ok('/inspect no longer sends file names as if they were photos', !/photoNames/.test(JS.replace(/\/\/.*$/gm, '')));
  // 2026-10-06 (shorter form): photos are picked on the thank-you "add
  // details" step; the submission's grant is kept and handed to afterSubmit.
  ok('/inspect hands the submission\'s photoToken to afterSubmit', /mountDetails\(res && res\.photoToken, data\)/.test(JS) && /photoToken: _grant/.test(JS));
  ok('the old "photos were not sent" note is gone from /inspect', !/inspectPhotoNote/.test(HTML) && !/inspectPhotoNote/.test(JS));
  ok('/inspect loads the shared intake block', /<div data-nbd-intake="ins"/.test(HTML) && /intake-extras\.js/.test(HTML));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
