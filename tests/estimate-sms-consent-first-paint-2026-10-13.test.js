#!/usr/bin/env node
'use strict';
/**
 * /estimate — the SMS opt-in must be on screen at first paint.
 *
 * Twilio rejected the A2P campaign (30909, 2026-10-13): the reviewer opened
 * /estimate and saw an address box and nothing else — the phone field and
 * the consent checkbox were on step 5 of a 5-step wizard, hidden until four
 * interactions had happened. tests/sms-consent-a2p-2026-10-05.test.js pins
 * the WORDS of every consent label; it cannot see that a label sits inside
 * a step nobody is shown. This suite pins WHERE it is.
 *
 *   B1  the phone field, first name and the consent box live in #step1
 *   B2  #step1 is the step that ships active; no other step does
 *   B3  nothing between #step1 and the checkbox is hidden (hidden attr,
 *       display:none, a non-active .step)
 *   B4  the box is unchecked in the markup, and the wizard never sets it true
 *   B5  the disclosure + BOTH links are inside the label, the phone field
 *       comes before it ("at the number above"), ids are unique, and step 5
 *       does not carry a second copy of the fields
 *   B6  the step counters still say "of 5" with five progress dots
 *
 * Comments are stripped first so a commented-out copy cannot satisfy a check.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const html = stripHtml(read('docs/estimate.html'));
const wiz = stripJs(read('docs/assets/js/inline/4053149b2f.js'));

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'param', 'track']);

/** Open ancestor tags (as written) of the tag starting at `target`, from the document start. */
function ancestorsOf(src, target) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(src)) && m.index < target) {
    const name = m[2].toLowerCase();
    if (/^(script|style)$/.test(name) && !m[1]) {
      const end = src.indexOf('</' + name, re.lastIndex);
      re.lastIndex = end === -1 ? src.length : end;
      continue;
    }
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name === name) { stack.length = i; break; }
    } else if (!VOID.has(name) && !/\/\s*$/.test(m[3])) {
      stack.push({ name, tag: m[0] });
    }
  }
  return stack;
}

// A wizard step is class="step ..." -- NOT step-container / step-title (\b would match those).
const isStep = (tag) => /class="(?:[^"]*\s)?step(?:\s[^"]*)?"/.test(tag);

const step1At = html.indexOf('id="step1"');
const step2At = html.indexOf('id="step2"');
const step5At = html.indexOf('id="step5"');
const loadingAt = html.indexOf('id="stepLoading"');
const step1 = html.slice(step1At, step2At);
const step5 = html.slice(step5At, loadingAt);

console.log('\n/estimate SMS CONSENT — visible on first paint\n' + '═'.repeat(64));

check('B0 anchors found (guards against a vacuous pass)', () => {
  assert.ok(step1At > 0 && step2At > step1At && step5At > step2At && loadingAt > step5At, 'step markers missing/out of order');
});

check('B1 first name, phone and the consent checkbox are inside #step1', () => {
  for (const id of ['firstName', 'phoneNumber', 'tcpaConsent']) {
    assert.ok(new RegExp('id="' + id + '"').test(step1), id + ' is not in #step1');
  }
});

check('B2 #step1 ships active and is the only active step', () => {
  const active = html.match(/<div class="step[^"]*\bactive\b[^"]*" id="[^"]+"/g) || [];
  assert.deepStrictEqual(active.map((a) => a.match(/id="([^"]+)"/)[1]), ['step1']);
});

check('B3 nothing around the consent box hides it (hidden / display:none / inactive step)', () => {
  const at = html.indexOf('id="tcpaConsent"');
  const inputStart = html.lastIndexOf('<input', at);
  const anc = ancestorsOf(html, inputStart);
  assert.ok(anc.length > 3, 'ancestor walk found too little — parser broken');
  const names = anc.map((a) => a.tag).join('\n');
  assert.ok(/id="step1"/.test(names), 'the consent box is not under #step1:\n' + names);
  for (const a of anc) {
    assert.ok(!/\shidden(\s|>|=)/.test(a.tag), 'hidden ancestor: ' + a.tag);
    assert.ok(!/display\s*:\s*none/i.test(a.tag), 'display:none ancestor: ' + a.tag);
    if (isStep(a.tag)) assert.ok(/\bactive\b/.test(a.tag), 'non-active step ancestor: ' + a.tag);
  }
  // The same for the phone field.
  const phoneAt = html.lastIndexOf('<input', html.indexOf('id="phoneNumber"'));
  for (const a of ancestorsOf(html, phoneAt)) {
    assert.ok(!/\shidden(\s|>|=)/.test(a.tag) && !/display\s*:\s*none/i.test(a.tag), 'hidden phone ancestor: ' + a.tag);
    if (isStep(a.tag)) assert.ok(/\bactive\b/.test(a.tag), 'non-active step above the phone: ' + a.tag);
  }
});

check('B4 the checkbox is not pre-checked in markup, and the wizard never sets it true', () => {
  const tag = html.match(/<input\b[^>]*id="tcpaConsent"[^>]*>/)[0];
  assert.ok(/type="checkbox"/.test(tag), 'tcpaConsent is not a checkbox');
  assert.ok(!/\bchecked\b/.test(tag), 'pre-checked: ' + tag);
  const sets = [...wiz.matchAll(/tcpaConsent['"]\)\.checked\s*=(?!=)\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(sets.length >= 1, 'reset assignment not found (guards against a vacuous pass)');
  assert.ok(sets.every((v) => v === 'false'), 'wizard assigns tcpaConsent.checked to something other than false: ' + sets.join(' | '));
  assert.ok(!/tcpaConsent\s*:\s*true\b/.test(wiz), 'wizard hardcodes tcpaConsent: true in a payload');
  assert.ok(/tcpaConsent['"]\)\.checked\b/.test(wiz) && /tcpaConsent:\s*consent\b/.test(wiz), 'wizard no longer reads the box into the payload');
});

check('B5a the label carries the disclosure and BOTH links, right beside the box', () => {
  const m = html.match(/<label for="tcpaConsent">([\s\S]*?)<\/label>/);
  assert.ok(m, 'no <label for="tcpaConsent">');
  const t = m[1];
  for (const need of [
    'No Big Deal Home Solutions', 'by call or text at the number above', 'Message frequency varies',
    'Message &amp; data rates may apply', 'Reply STOP to opt out, HELP for help', 'Consent is not a condition of purchase',
    '<a href="/privacy#sms-terms">Privacy Policy</a>', '<a href="/terms">Terms</a>'
  ]) assert.ok(t.includes(need), 'label lacks: ' + need);
  assert.ok(!/\bon[a-z]+\s*=/.test(t), 'inline handler in the label');
});

check('B5b the phone field comes BEFORE the label ("at the number above")', () => {
  assert.ok(html.indexOf('id="phoneNumber"') < html.indexOf('<label for="tcpaConsent">'));
});

check('B5c each contact id appears once, and step 5 holds no second copy', () => {
  for (const id of ['firstName', 'phoneNumber', 'tcpaConsent']) {
    assert.strictEqual((html.match(new RegExp('\\bid="' + id + '"', 'g')) || []).length, 1, 'id ' + id + ' count');
    assert.ok(!new RegExp('id="' + id + '"').test(step5), id + ' is back in #step5');
  }
  assert.ok(!/type="checkbox"/.test(step5), 'step 5 grew a checkbox');
});

check('B5d the consent box is not wired to a submit/continue control (never bundled)', () => {
  const cont = step1.match(/<button[^>]*data-step="2"[^>]*>/)[0];
  assert.ok(!/tcpaConsent/.test(cont), 'Continue references the consent box');
  assert.ok(!/<button/.test(html.match(/<label for="tcpaConsent">[\s\S]*?<\/label>/)[0]), 'a button inside the consent label');
});

check('B6 step counters stay honest: "Step N of 5" and five progress dots', () => {
  const eyebrows = [...html.matchAll(/Step (\d) of (\d)/g)].map((m) => m[1] + '/' + m[2]);
  assert.deepStrictEqual(eyebrows, ['1/5', '2/5', '3/5', '4/5']);
  for (let i = 1; i <= 5; i++) assert.ok(html.includes('id="dot' + i + '"'), 'dot' + i);
  assert.ok(!html.includes('id="dot6"'));
});

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
