'use strict';
// Runs docs/assets/js/quick-lead-form.js in a vm against one stub host and
// returns the parsed form it builds, so a test asserts on the rendered
// structure instead of the script's text (2026-11-17).
const K = require('./src-kit');

function renderQuickForm(attrs) {
  attrs = attrs || {};
  let captured = '';
  const stub = () => ({ addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, appendChild() {}, value: '', checked: false, childElementCount: 0 });
  const host = {
    offsetTop: 0,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    set innerHTML(v) { captured = v; },
    get innerHTML() { return captured; },
    querySelector: () => stub(),
  };
  const document = {
    readyState: 'complete',
    querySelectorAll: (sel) => (sel === '[data-nbd-quick-form]' ? [host] : []),
    querySelector: () => null,
    getElementById: () => stub(),
    createElement: () => stub(),
    head: { appendChild() {} },
    addEventListener() {},
  };
  K.loadInVm(['docs/assets/js/quick-lead-form.js'], { document, Promise, setTimeout, location: { pathname: '/x', search: '' } });
  return K.parseTags(captured);
}

module.exports = { renderQuickForm };
