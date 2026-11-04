/**
 * tests/agent-inbox-keyboard-2026-10-24.test.js
 *
 * Overnight audit 2026-10-23 (pass 1, demo walk row 6, "Agent inbox keyboard"):
 * the inbox is aria-modal, but focus stayed on the sidebar and Tab walked the
 * page behind it (Escape already closed it). Pins on the REAL agent-inbox.js
 * in a vm with a small fake DOM:
 *   - opening moves focus to the first visible control (Close), never to a
 *     hidden bulk button
 *   - Tab / Shift+Tab wrap inside the modal; a Tab from behind lands inside
 *   - Escape still closes it, and focus goes back to what opened it
 *   - open() replacing an open inbox keeps the ORIGINAL opener
 *
 * Run: node tests/agent-inbox-keyboard-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

function load() {
  const listeners = {};
  const byId = {};
  let active = null;
  const outside = [];
  const pageButton = (name) => { const n = { name, gone: false, focus() { active = this; } }; outside.push(n); return n; };
  // Focusable stand-ins parsed from the overlay markup (hidden / tabindex -1 excluded, as a browser does).
  const RE = /<(button|a|input|select|textarea)\b([^>]*)>/g;
  const mkOverlay = () => {
    const ov = { className: '', id: '', innerHTML: '', attached: false, _nodes: null, _html: null };
    const nodes = () => {
      if (ov._html !== ov.innerHTML) {
        ov._html = ov.innerHTML; ov._nodes = [];
        let m; RE.lastIndex = 0;
        while ((m = RE.exec(ov.innerHTML))) {
          if (/\shidden\b|tabindex="-1"|\sdisabled\b/.test(m[2])) continue;
          ov._nodes.push({ tag: m[1], act: (/data-ai-act="([^"]*)"/.exec(m[2]) || [])[1] || null, owner: ov, focus() { active = this; } });
        }
      }
      return ov._nodes;
    };
    const modal = { tabIndex: -1, focus() { active = this; }, querySelectorAll: () => nodes(), querySelector: () => nodes()[0] || null, contains: (n) => n === modal || nodes().includes(n) };
    ov.querySelector = (sel) => (sel === '.ai-modal' ? modal : nodes()[0] || null);
    ov.querySelectorAll = () => nodes();
    ov.contains = (n) => n === ov || modal.contains(n);
    ov.remove = () => { ov.attached = false; if (byId[ov.id] === ov) delete byId[ov.id]; };
    ov.modal = modal; ov.nodes = nodes;
    return ov;
  };
  const document = {
    readyState: 'complete',
    get activeElement() { return active; },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    getElementById: (id) => byId[id] || null,
    createElement: () => mkOverlay(),
    body: { appendChild(e) { e.attached = true; if (e.id) byId[e.id] = e; } },
    contains: (n) => !!n && ((outside.includes(n) && !n.gone) || Object.values(byId).some((e) => e.contains && e.contains(n))),
  };
  const win = { location: { search: '', pathname: '/pro/dashboard.html', hash: '' }, history: { replaceState() {} }, _user: { uid: 'u1' }, _userClaims: {} };
  win.window = win;
  const ctx = vm.createContext({ window: win, document, console, setTimeout, clearTimeout, JSON, Math, String, Promise });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'agent-inbox.js'), 'utf8'), ctx, { filename: 'agent-inbox.js' });
  const key = (k, mods) => { const ev = Object.assign({ key: k, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, mods || {}); (listeners.keydown || []).forEach((fn) => fn(ev)); return ev; };
  return { A: win.NBDAgentInbox, key, pageButton, focusOn: (n) => { active = n; }, active: () => active, ov: () => byId.aiOverlay || null };
}

(async () => {
  console.log('\n1. opening moves focus inside');
  {
    const t = load();
    const opener = t.pageButton('sidebar');
    t.focusOn(opener);
    await t.A.open();
    const ov = t.ov();
    ok('control: the inbox opened', !!ov && ov.attached);
    const f = ov.nodes();
    ok('control: it has visible controls (hidden bulk buttons excluded)', f.length >= 2 && f[0].act === 'close', f.map((n) => n.act || n.tag).join(','));
    ok('focus is inside, on the first visible control (Close)', t.active() === f[0], t.active() && (t.active().name || t.active().act));
  }

  console.log('\n2. Tab stays inside');
  {
    const t = load();
    t.focusOn(t.pageButton('sidebar'));
    await t.A.open();
    const f = t.ov().nodes();
    t.focusOn(f[f.length - 1]);
    let ev = t.key('Tab');
    ok('Tab on the last control wraps to the first', t.active() === f[0] && ev.defaultPrevented);
    ev = t.key('Tab', { shiftKey: true });
    ok('Shift+Tab on the first control wraps to the last', t.active() === f[f.length - 1] && ev.defaultPrevented);
    t.focusOn(t.pageButton('behind'));
    ev = t.key('Tab');
    ok('a Tab while focus is behind the inbox lands inside it', t.active() === f[0] && ev.defaultPrevented);
    if (f.length > 2) { t.focusOn(f[1]); ev = t.key('Tab'); ok('control: Tab in the middle is left to the browser', !ev.defaultPrevented); }
  }

  console.log('\n3. Escape and closing');
  {
    const t = load();
    const opener = t.pageButton('sidebar');
    t.focusOn(opener);
    await t.A.open();
    t.key('Escape');
    ok('Escape closes the inbox', !t.ov());
    ok('focus goes back to what opened it', t.active() === opener, t.active() && (t.active().name || t.active().act));
    const ev = t.key('Tab');
    ok('control: with the inbox closed, Tab is left alone', !ev.defaultPrevented);
  }
  {
    const t = load();
    const opener = t.pageButton('sidebar');
    t.focusOn(opener);
    await t.A.open();
    await t.A.open();                          // re-opened over itself (the bell link, the deck coming back)
    t.A.close();
    ok('open() over an open inbox keeps the ORIGINAL opener for the focus return', t.active() === opener, t.active() && (t.active().name || t.active().act));
  }
  {
    const t = load();
    const opener = t.pageButton('sidebar');
    t.focusOn(opener);
    await t.A.open();
    opener.gone = true;                        // the sidebar was re-drawn
    t.A.close();
    ok('a removed opener is not focused (no focus on a detached node)', t.active() !== opener);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
