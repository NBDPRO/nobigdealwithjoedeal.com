/**
 * tests/reviews-near-forms-2026-11-26.test.js — CRO open item 4
 * (documentation/projects/NEXT_SESSION-2026-11-17-site-cro.md).
 *
 * Runs the real docs/assets/js/google-reviews-widget.js and
 * docs/assets/js/quick-lead-form.js in a vm and checks behaviour, not text:
 *   - the widget fills EVERY [data-nbd-google-reviews] (it filled only the first)
 *   - a container added after the fetch (the quick form's) is filled through
 *     window.nbdHydrateReviewHooks(), once
 *   - data-nbd-gr-compact renders the newest real card(s) with the date and
 *     no rating/count pills; a failed fetch gives every container the fallback
 *   - the quick form carries the compact review on /services/ pages only
 *
 * Zero deps. Run: node tests/reviews-near-forms-2026-11-26.test.js
 */
'use strict';
const K = require('./lib/src-kit');

const t = K.suite('reviews beside the lead forms');

function makeEl(attrs) {
  const a = Object.assign({}, attrs);
  return {
    innerHTML: '',
    renders: 0,
    getAttribute: (k) => (k in a ? a[k] : null),
    hasAttribute: (k) => k in a,
    setAttribute(k, v) { a[k] = String(v); },
    querySelectorAll: () => [],
  };
}
function trackRenders(el) {
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set(v) { html = v; el.renders++; },
  });
  return el;
}

function runWidget(containers, fetchImpl) {
  const document = {
    readyState: 'complete',
    querySelectorAll: (sel) => (sel === '[data-nbd-google-reviews]' ? containers.slice() : []),
    querySelector: () => null,
    addEventListener() {},
    createElement() {
      let s = '';
      return {
        set textContent(v) { s = String(v); },
        get innerHTML() { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
      };
    },
  };
  return K.loadInVm(['docs/assets/js/google-reviews-widget.js'], { document, fetch: fetchImpl, Promise, Date, console: { warn() {}, log() {} } });
}

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const PAYLOAD = {
  rating: 5, total: 2, profileUrl: 'https://g.page/r/x',
  reviews: [
    { author: 'Newest Person', rating: 5, text: 'Joe was great.', time: now - 3 * DAY, relativeTime: '3 days ago' },
    { author: 'Older Person', rating: 5, text: 'Good roof.', time: now - 40 * DAY, relativeTime: 'a month ago' },
  ],
};
const okFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(PAYLOAD) });
const cards = (html) => (html.match(/class="gr-card"/g) || []).length;
const flush = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  t.section('1. every container on the page is filled');
  const full = trackRenders(makeEl({ 'data-nbd-google-reviews': '' }));
  const compact = trackRenders(makeEl({ 'data-nbd-google-reviews': '', 'data-nbd-gr-limit': '1', 'data-nbd-gr-compact': '' }));
  const list = [full, compact];
  const ctx = runWidget(list, okFetch);
  await flush(); await flush(); await flush();
  t.ok('the full strip renders both cards with the rating pills', cards(full.innerHTML) === 2 && /Google Reviews/.test(full.innerHTML), full.innerHTML.slice(0, 200));
  t.ok('the compact one (second on the page) renders one card, the newest, with its date and no pills',
    cards(compact.innerHTML) === 1 && /Newest Person/.test(compact.innerHTML) && !/Older Person/.test(compact.innerHTML) &&
    /<time datetime="\d{4}-\d\d-\d\d">/.test(compact.innerHTML) && !/Google Reviews<\/div>/.test(compact.innerHTML) && !/review(s)? ·|\d review/.test(compact.innerHTML),
    compact.innerHTML.slice(0, 400));

  t.section('2. a container added after the fetch is filled once');
  const late = trackRenders(makeEl({ 'data-nbd-google-reviews': '', 'data-nbd-gr-limit': '1', 'data-nbd-gr-compact': '' }));
  list.push(late);
  ctx.window.nbdHydrateReviewHooks();
  const fullRenders = full.renders;
  ctx.window.nbdHydrateReviewHooks();
  t.ok('nbdHydrateReviewHooks() fills the late container, and a second call re-renders nothing',
    cards(late.innerHTML) === 1 && late.renders === 1 && full.renders === fullRenders, `late renders ${late.renders}`);

  t.section('3. a failed fetch gives every container the Google fallback');
  const a = trackRenders(makeEl({ 'data-nbd-google-reviews': '' }));
  const b = trackRenders(makeEl({ 'data-nbd-google-reviews': '', 'data-nbd-gr-compact': '' }));
  runWidget([a, b], () => Promise.reject(new Error('offline')));
  await flush(); await flush(); await flush();
  t.ok('both show "Read our reviews on Google", neither keeps "Loading"',
    [a, b].every((el) => /Read our reviews on Google/.test(el.innerHTML) && !/Loading/.test(el.innerHTML)));

  t.section('4. the quick form carries the compact review on service pages only');
  function quickForm(pathname) {
    let html = '';
    const stub = () => ({ addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, appendChild() {}, value: '', checked: false, childElementCount: 0 });
    const host = { offsetTop: 0, getAttribute: () => null, set innerHTML(v) { html = v; }, get innerHTML() { return html; }, querySelector: () => stub() };
    const document = {
      readyState: 'complete',
      querySelectorAll: (sel) => (sel === '[data-nbd-quick-form]' ? [host] : []),
      querySelector: () => null, getElementById: () => stub(), createElement: () => stub(),
      head: { appendChild() {} }, addEventListener() {},
    };
    K.loadInVm(['docs/assets/js/quick-lead-form.js'], { document, Promise, setTimeout, location: { pathname, search: '' } });
    return K.parseTags(html);
  }
  const svc = quickForm('/services/roof-replacement').$$('[data-nbd-google-reviews]');
  t.ok('/services/… renders one compact, one-card review container inside the form',
    svc.length === 1 && svc[0].parent.tag === 'form' && svc[0].has('data-nbd-gr-compact') && svc[0].attr('data-nbd-gr-limit') === '1', JSON.stringify(svc.map((n) => n.attrs)));
  t.ok('/areas/… and the homepage render none',
    quickForm('/areas/mason-oh').$$('[data-nbd-google-reviews]').length === 0 &&
    quickForm('/').$$('[data-nbd-google-reviews]').length === 0);

  t.done();
})();
