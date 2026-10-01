/**
 * tests/crm-list-view-default.test.js — pipeline Board/List default
 * (docs/pro/js/crm-list-view.js), 2026-09-24.
 *
 * Two behaviours, both from a phone walk of the dashboard:
 *   1. With no saved choice, a phone (<=768px) opens List and a computer opens
 *      Board. The board showed 1.5 columns at 412px and scrolled sideways.
 *   2. Settings > Pipeline Preferences > Default Pipeline View: Auto forgets
 *      the saved choice (the device decides again); Board and List pin it;
 *      the matching picker button lights up.
 *
 * Drives the real file in a vm sandbox with a stub matchMedia and
 * localStorage. Zero deps. Run: node tests/crm-list-view-default.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/crm-list-view.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; fails.push(label); }
}

function load({ phone, saved }) {
  const store = {};
  if (saved) store['nbd-crm-view-mode'] = saved;
  const bodyClasses = new Set();
  const pickers = ['auto', 'board', 'list'].map((v) => {
    const cls = new Set(); const attrs = { 'data-view-default': v };
    return {
      style: {}, cls,
      classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      setAttribute: (k, val) => { attrs[k] = String(val); },
    };
  });
  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    matchMedia: () => ({ matches: !!phone }),
    document: {
      body: { classList: { toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) } },
      getElementById: () => null,
      querySelectorAll: (sel) => (sel === '.cview-default-btn' ? pickers : []),
      querySelector: () => null,
      addEventListener() {},
    },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    Date, Math, JSON, String, Number, Array, Object,
  };
  win.window = win;
  vm.runInNewContext(SRC, win, { filename: 'crm-list-view.js' });
  // The active look is .ui-seg.is-on in ui-primitives.css; aria-pressed must agree.
  const lit = () => pickers.filter((p) => p.cls.has('is-on') && p.getAttribute('aria-pressed') === 'true').map((p) => p.getAttribute('data-view-default'));
  return { win, store, listMode: () => bodyClasses.has('crm-list-mode'), lit };
}

console.log('\nDEFAULT — no saved choice');
{
  const p = load({ phone: true });
  ok('phone with no saved choice opens List', p.listMode() === true);
  ok('...and the picker shows Auto', p.lit().join() === 'auto');
  const d = load({ phone: false });
  ok('computer with no saved choice opens Board', d.listMode() === false);
}

console.log('\nSAVED CHOICE WINS');
ok('phone with Board saved opens Board', load({ phone: true, saved: 'board' }).listMode() === false);
ok('computer with List saved opens List', load({ phone: false, saved: 'list' }).listMode() === true);

console.log('\nSETTINGS PICKER');
{
  const t = load({ phone: true, saved: 'board' });
  ok('Board saved lights the Board button', t.lit().join() === 'board');
  t.win.crmViewAuto();
  ok('Auto forgets the saved choice', !('nbd-crm-view-mode' in t.store));
  ok('...so the phone falls back to List', t.listMode() === true);
  ok('...and the Auto button lights', t.lit().join() === 'auto');
  t.win.crmViewList();
  ok('List pins list', t.store['nbd-crm-view-mode'] === 'list' && t.lit().join() === 'list');
  t.win.crmViewBoard();
  ok('Board pins board and leaves list mode', t.store['nbd-crm-view-mode'] === 'board' && t.listMode() === false);
}

// ── Phone field cards (2026-09-24) ────────────────────────────────
// render() on a phone builds cards; the swipe handlers are driven by fake
// touch events on fake card elements parsed back out of the markup.
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function loadCards({ phone, leads, ua, stageOptionsForType }) {
  const moves = [];
  const toasts = [];
  let hrefSet = null;
  const cards = [];
  const wrap = {
    _html: '',
    set innerHTML(v) {
      this._html = String(v);
      cards.length = 0;
      // Every data-* attribute on each card div (data-next / data-next-msg
      // joined data-id / data-phone / data-stage on 2026-09-25).
      const re = /<div class="cl-card" ([^>]*)>/g;
      let m;
      while ((m = re.exec(this._html))) {
        const attrs = {};
        m[1].replace(/(data-[a-z-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = unesc(v); });
        const h = {};
        const cls = new Set(['cl-card']);
        cards.push({
          attrs, h, style: {}, cls,
          classList: {
            toggle(c, on) { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
            remove(...cs) { cs.forEach((c) => cls.delete(c)); },
          },
          getAttribute: (k) => (k in attrs ? attrs[k] : null),
          addEventListener: (t, f) => { h[t] = f; },
        });
      }
    },
    get innerHTML() { return this._html; },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '.cl-card' ? cards : []),
  };
  const win = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: !!phone }),
    navigator: { userAgent: ua || 'Android' },
    location: {},
    document: {
      body: { classList: { toggle() {} } },
      getElementById: (id) => (id === 'crmListWrap' ? wrap : null),
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
    },
    _stageKeys: ['new', 'contacted', 'inspected', 'closed', 'lost'],
    stageLabel: (k) => k.toUpperCase(),
    _leads: leads,
    showToast: (m) => toasts.push(m),
    // Stub moveCard: applies the move unless the stage is 'inspected'
    // (standing in for a stage gate the rep cancels).
    moveCard: async (id, stage) => {
      moves.push([id, stage]);
      if (stage === 'inspected') return;
      const l = leads.find((x) => x.id === id);
      if (l) l.stage = stage;
    },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
    Date, Math, JSON, String, Number, Array, Object, Promise,
  };
  if (stageOptionsForType) win.stageOptionsForType = stageOptionsForType;
  win.window = win;
  Object.defineProperty(win.location, 'href', { set: (v) => { hrefSet = v; }, get: () => hrefSet });
  vm.runInNewContext(SRC, win, { filename: 'crm-list-view.js' });
  win.CrmListView.render(leads);
  const swipe = (card, dx) => {
    card.h.touchstart({ target: {}, touches: [{ clientX: 200, clientY: 300 }] });
    card.h.touchmove({ touches: [{ clientX: 200 + dx, clientY: 302 }] });
    card.h.touchend({});
  };
  return { wrap, cards, moves, toasts, swipe, href: () => hrefSet };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log('\nFIELD CARDS — phone rendering');
  {
    const t = loadCards({ phone: true, leads: [
      { id: 'a', firstName: '<img src=x onerror=alert(1)>', stage: 'new', phone: '(513) 555-0101', address: '1 Main St, Loveland OH', jobValue: 14200 },
      { id: 'b', firstName: 'Nophone', stage: 'contacted', address: '' },
    ] });
    const html = t.wrap.innerHTML;
    ok('phone renders cards, not the table', /class="cl-card"/.test(html) && !/crm-list-table/.test(html));
    ok('lead name is escaped (no live markup)', html.includes('&lt;img src=x onerror=alert(1)&gt;') && !html.includes('<img src=x'));
    ok('Call and Text use the digits-only number', html.includes('href="tel:5135550101"') && html.includes('href="sms:5135550101"'));
    ok('Map uses Google Maps on Android', html.includes('https://www.google.com/maps/search/?api=1&amp;query=1%20Main%20St'));
    ok('a lead with no phone and no address gets only Open', (() => {
      // Anchor on the card div: the stage <select> repeats data-id="b".
      const card = html.split('class="cl-card" data-id="b"')[1] || '';
      return !/cl-call|cl-text|cl-map/.test(card.split('</div></div>')[0]) && /cl-open/.test(card);
    })());
    const iphone = loadCards({ phone: true, ua: 'iPhone', leads: [{ id: 'a', stage: 'new', address: '1 Main St' }] });
    ok('Map uses Apple Maps on iPhone', iphone.wrap.innerHTML.includes('https://maps.apple.com/?q=1%20Main%20St'));
    const desk = loadCards({ phone: false, leads: [{ id: 'a', stage: 'new' }] });
    ok('CONTROL desktop still renders the table', /crm-list-table/.test(desk.wrap.innerHTML) && !/cl-card/.test(desk.wrap.innerHTML));
  }

  console.log('\nFIELD CARDS — swipes');
  {
    const leads = [
      { id: 'a', stage: 'new', phone: '5135550101' },
      { id: 'b', stage: 'contacted', phone: '' },
      { id: 'c', stage: 'closed', phone: '5135550103' },
    ];
    const t = loadCards({ phone: true, leads });
    const card = (id) => t.cards.find((c) => c.attrs['data-id'] === id);
    t.swipe(card('a'), 120);
    ok('swipe right calls the lead', t.href() === 'tel:5135550101');
    t.swipe(card('a'), -120);
    await settle(); await settle();
    ok('swipe left moves to the next stage through moveCard', JSON.stringify(t.moves[0]) === '["a","contacted"]');
    ok('...and confirms once the lead reads the new stage', t.toasts.includes('Moved to CONTACTED'));
    t.swipe(card('b'), -120);
    await settle(); await settle();
    ok('a cancelled move (stage gate) is NOT confirmed', t.moves.some((m) => m[1] === 'inspected') && !t.toasts.includes('Moved to INSPECTED'));
    t.swipe(card('c'), -120);
    ok('Closed never advances (Lost/Closed are never swipe targets)', !t.moves.some((m) => m[0] === 'c') && t.toasts.includes('Already at the last stage'));
    t.swipe(card('b'), 120);
    ok('swipe right with no phone says so instead of dialing', t.toasts.includes('No phone number on this lead'));
    const before = t.moves.length;
    t.swipe(card('a'), 40);
    ok('a short drag does nothing', t.moves.length === before);
    card('a').h.touchstart({ target: { closest: () => ({}) }, touches: [{ clientX: 200, clientY: 300 }] });
    card('a').h.touchmove({ touches: [{ clientX: 360, clientY: 302 }] });
    card('a').h.touchend({});
    ok('a swipe that starts on a control is ignored', t.moves.length === before);
  }

  // 2026-09-25 phone audit: the select and the swipe used the CURRENT VIEW's
  // columns, and the Ins view stops at Contract Signed — so a job being
  // installed read "New Lead" (a select with no matching option shows its
  // first) and swiping it said "Already at the last stage". Both now use the
  // lead's own track (stageOptionsForType, what the board's ⋮ submenu offers).
  console.log('\nFIELD CARDS — the lead\'s own track');
  {
    const TRACK = ['new', 'contacted', 'inspected', 'contract_signed', 'job_created', 'install_in_progress',
      'install_complete', 'collections', 'closed', 'warranty_claim', 'lost'];
    const leads = [
      { id: 'i', stage: 'install_in_progress', phone: '' },
      { id: 'k', stage: 'collections', phone: '' },
      { id: 'x', stage: 'custom_mystery', phone: '5135550109' },
    ];
    const t = loadCards({ phone: true, leads, stageOptionsForType: () => TRACK.map((k) => ({ value: k, label: k.toUpperCase() })) });
    const html = t.wrap.innerHTML;
    const selectOf = (id) => (html.split('class="cl-card" data-id="' + id + '"')[1] || '').split('</select>')[0];
    const selected = (id) => { const m = /<option value="([^"]*)" selected>/.exec(selectOf(id)); return m && m[1]; };
    const card = (id) => t.cards.find((c) => c.attrs['data-id'] === id);
    ok('a stage outside the view (Installing) is the selected option', selected('i') === 'install_in_progress');
    ok('the select offers the whole track, job stages included', /value="install_complete"/.test(selectOf('i')) && /value="closed"/.test(selectOf('i')));
    ok('a stage outside the track still gets its own selected option', selected('x') === 'custom_mystery');
    t.swipe(card('i'), -120);
    await settle(); await settle();
    ok('swipe-left on an installing job moves it to Install Done', t.moves.some((m) => m[0] === 'i' && m[1] === 'install_complete'));
    ok('...with no false "last stage" toast', !t.toasts.includes('Already at the last stage'));
    t.swipe(card('k'), -120);
    ok('Collections stops in front of Closed instead of jumping to Warranty Claim',
      !t.moves.some((m) => m[0] === 'k') && t.toasts.includes('Next is CLOSED — pick it from the stage list'));
    t.swipe(card('x'), -120);
    ok('an off-track stage points at the stage list', !t.moves.some((m) => m[0] === 'x') && t.toasts.includes('Pick the next stage from the stage list'));

    // touchcancel (the OS takes the gesture: notification shade, a call)
    // resets the card and never acts; before, no listener existed and the
    // card stayed 120px sideways in the green "call" state.
    const c = card('x');
    const nMoves = t.moves.length, hrefBefore = t.href();
    c.h.touchstart({ target: {}, touches: [{ clientX: 100, clientY: 300 }] });
    c.h.touchmove({ touches: [{ clientX: 230, clientY: 301 }] });
    ok('mid-swipe the card is offset and marked', c.style.transform === 'translateX(130px)' && c.cls.has('cl-card-swipe-call'));
    ok('a touchcancel listener exists', typeof c.h.touchcancel === 'function');
    if (c.h.touchcancel) c.h.touchcancel({});
    ok('touchcancel snaps the card back', c.style.transform === '' && !c.cls.has('cl-card-swipe-call') && !c.cls.has('cl-card-swipe-next'));
    ok('...and neither calls nor moves', t.moves.length === nMoves && t.href() === hrefBefore);
    if (c.h.touchend) c.h.touchend({});
    ok('a stray touchend after the cancel does nothing', t.moves.length === nMoves && t.href() === hrefBefore);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
})();
