/**
 * tests/inspect-cro-light-2026-10-06.test.js — the light /inspect fixes from
 * the CRO review (nbd-content/inspect-cro-review-2026-10-06.md, #4 #5 #9 #10).
 *
 *  #4  One reply promise. Jo (2026-10-06): keep the "24-Hour" headline, and the
 *      reply time is "usually the same day" — so "within the hour" is gone.
 *  #5  Proof on the first screen: live Google rating hooks, GAF Certified,
 *      TAMKO Pro Gold, and the decided "Fully insured" (never a bare "Insured").
 *  #9  The subhead/meta/OG no longer lead with "insurance restoration" or the
 *      "No pressure. No obligation." negation list.
 *  #10 inspect-analytics.js sends inspect_form_start / inspect_form_error /
 *      contact_tap with ids and places only — run here against a fake DOM.
 *
 * Zero deps. Run: node tests/inspect-cro-light-2026-10-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const raw = fs.readFileSync(path.join(ROOT, 'docs', 'inspect.html'), 'utf8').replace(/\r\n/g, '\n');
// Comments stripped so a commented-out line can't satisfy (or trip) a check.
const html = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
// Visible text only: the JSON-LD schema-entity partial is owned elsewhere (#2203).
const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, '’').replace(/&mdash;/g, '—').replace(/\s+/g, ' ');

console.log('#4 reply promise');
ok('no "within the hour" anywhere on /inspect', !/within\s+the\s+hour/i.test(html));
ok('the hero phone line says "usually the same day"',
  /class="phone-sub"[^>]*>[^<]*usually the same day/i.test(html));
ok('the 24-Hour headline is kept (Jo, 2026-10-06)', /<h1>\s*Free 24-Hour\s*<span>Roof Inspection<\/span>\s*<\/h1>/.test(html));

console.log('#5 proof pills');
const row = (html.match(/<div class="trust-row">([\s\S]*?)\n\s*<\/div>/) || [])[1] || '';
const pills = [...row.matchAll(/<span class="trust-pill">([\s\S]*?)<\/span>\s*(?=<span class="trust-pill">|$)/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
ok('hero trust row found', row.length > 0);
ok('rating pill uses the live data-nbd-gr-rating + data-nbd-gr-total hooks',
  /data-nbd-gr-rating>[\d.]+<\/span>\s*on Google\s*\(<span data-nbd-gr-total>\d+<\/span>\s*reviews\)/.test(row));
['GAF Certified', 'TAMKO Pro Gold', 'Fully insured'].forEach((p) => {
  ok('pill "' + p + '"', pills.some((x) => x.replace(/^\W+/, '') === p), JSON.stringify(pills));
});
ok('no bare "Insured" pill (decided wording is "Fully insured")', !pills.some((x) => /^\W*Insured$/i.test(x)), JSON.stringify(pills));
ok('no "Licensed" on /inspect', !/licensed/i.test(text));
ok('no Master Elite / President\'s Club over-claim', !/master elite|president.?s club/i.test(text));
ok('google-reviews-widget.js still loads (it hydrates the hooks)', /<script[^>]+src="\/assets\/js\/google-reviews-widget\.js"/.test(html));

console.log('#9 subhead / meta / OG');
const head = (html.slice(0, html.indexOf('</head>')).match(/<meta[^>]+>/g) || []).join('\n');
const sub = (html.match(/<p class="subhead">([\s\S]*?)<\/p>/) || [])[1] || '';
ok('subhead found', sub.length > 0);
ok('subhead no longer leads with insurance restoration', !/insurance/i.test(sub), sub);
ok('subhead has no "No pressure. No obligation." negation list', !/no\s+pressure|no\s+obligation/i.test(sub), sub);
ok('meta description + og:description drop "insurance restoration"', !/insurance restoration/i.test(head));
ok('meta description + og:description drop "no pressure / no obligation"', !/no\s+pressure|no\s+obligation/i.test(head));
ok('subhead names the owner and the 7+ years', /Joe Deal, owner/.test(sub) && /7\+ years/.test(sub));
ok('no founding year in the subhead', !/(since|founded|est\.?)\s*(19|20)\d\d/i.test(sub));

console.log('#10 analytics');
ok('inspect-analytics.js is loaded with defer from an external file',
  /<script defer src="\/assets\/js\/inspect-analytics\.js"><\/script>/.test(html));
const jsSrc = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'js', 'inspect-analytics.js'), 'utf8');
const jsCode = jsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('never reads an input value (no PII)', !/\.value\b/.test(jsCode) && !/textContent|innerText|innerHTML/.test(jsCode));

// --- tiny fake DOM -------------------------------------------------------
function el(id, attrs, parent) {
  const e = { id: id || '', attrs: attrs || {}, parent: parent || null, listeners: {}, checked: false,
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    closest(sel) {
      const parts = sel.split(',').map((s) => s.trim());
      for (let n = this; n; n = n.parent) {
        for (const p of parts) {
          if (p === 'a[href^="tel:"]' && n.tag === 'a' && /^tel:/.test(n.attrs.href || '')) return n;
          if (p === 'a[href^="sms:"]' && n.tag === 'a' && /^sms:/.test(n.attrs.href || '')) return n;
          if (p[0] === '#' && n.id === p.slice(1)) return n;
          if (p[0] === '.' && (n.attrs.class || '').split(/\s+/).includes(p.slice(1))) return n;
        }
      }
      return null;
    } };
  return e;
}
const events = [];
const docListeners = {};
const heroLeft = el('', { class: 'hero-left' });
const strip = el('', { class: 'mobile-cta-strip mobile-cta-bookfirst' });
const formPanel = el('', { class: 'form-panel' });
const form = el('inspectForm', {}, formPanel);
const consent = el('ins-consent', {}, form);
const inputs = [el('f-name', { 'aria-invalid': 'false' }, form), el('f-address', { 'aria-invalid': 'false' }, form), el('f-phone', { 'aria-invalid': 'false' }, form)];
form.querySelectorAll = (sel) => (sel === '[aria-invalid="true"]' ? inputs.filter((i) => i.attrs['aria-invalid'] === 'true') : []);
let observer = null;
const sandbox = {
  window: { gtag: function () { events.push([].slice.call(arguments)); } },
  document: {
    readyState: 'complete',
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    getElementById(id) { return { inspectForm: form, 'ins-consent': consent }[id] || null; }
  },
  MutationObserver: function (cb) { this.observe = () => { observer = cb; }; }
};
vm.runInNewContext(jsSrc, sandbox);
const tap = (a) => (docListeners.click || []).forEach((fn) => fn({ target: a }));
const fire = (t) => (form.listeners[t] || []).forEach((fn) => fn({}));
const added = (node) => observer && observer([{ addedNodes: [node] }]);
const names = () => events.map((e) => e[1]);

fire('focusin'); fire('focusin');
ok('inspect_form_start fires once on the first focus', names().filter((n) => n === 'inspect_form_start').length === 1, JSON.stringify(events));

inputs[2].attrs['aria-invalid'] = 'true';
added({ id: 'inspectFormError' });
let last = events[events.length - 1];
ok('inspect_form_error names the invalid field ids', last[1] === 'inspect_form_error' && last[2].fields === 'f-phone', JSON.stringify(last));
inputs[2].attrs['aria-invalid'] = 'false';
added({ id: 'inspectFormError' });
last = events[events.length - 1];
ok('consent refusal reports ins-consent', last[2] && last[2].fields === 'ins-consent', JSON.stringify(last));
consent.checked = true;
added({ id: 'inspectFormError' });
last = events[events.length - 1];
ok('a server-side failure reports "submit"', last[2] && last[2].fields === 'submit', JSON.stringify(last));
const before = events.length;
added({ id: 'somethingElse' });
ok('other added nodes are ignored', events.length === before);

const hits = [];
[[el('', { href: 'tel:+18594207382' }, heroLeft), 'tel', 'hero'],
 [el('', { href: 'sms:+18594207382' }, strip), 'sms', 'sticky'],
 [el('', { href: 'tel:+18594207382' }, formPanel), 'tel', 'form']].forEach(([a, method, place]) => {
  const n = events.length; a.tag = 'a'; tap(a);
  const e = events[n];
  hits.push(e);
  ok('contact_tap ' + method + ' @ ' + place, e && e[1] === 'contact_tap' && e[2].method === method && e[2].place === place, JSON.stringify(e));
});
ok('contact_tap carries no phone number', hits.every((e) => e && !/\d{7}/.test(JSON.stringify(e[2]))));
const n0 = events.length;
const plain = el('', { href: '/privacy' }); plain.tag = 'a'; tap(plain);
ok('a non-tel/sms link sends nothing', events.length === n0);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
