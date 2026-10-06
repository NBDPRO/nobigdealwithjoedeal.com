#!/usr/bin/env node
'use strict';
/**
 * SMS consent — carrier (Twilio A2P 10DLC) elements on every homeowner form.
 *
 * Twilio's campaign reviewers compare the campaign's opt-in description to
 * the live page. Every homeowner-site checkbox that covers texts must carry
 * the same sentence, with only the form's own "what" changing:
 *
 *   I agree to receive [what] from No Big Deal Home Solutions by call or text
 *   at the number above. Message frequency varies. Message & data rates may
 *   apply. Reply STOP to opt out, HELP for help. Consent is not a condition of
 *   purchase. Privacy Policy   (linked to /privacy#sms-terms)
 *
 * The blocks are DISCOVERED (every checkbox under docs/ outside docs/pro whose
 * label talks about texts), not listed, so a new form that ships a weaker
 * disclosure fails here too. Comments are stripped first so a commented-out
 * copy of the sentence cannot satisfy the check.
 *
 * Wording pin vs the stored consent record: tests/tcpa-consent.test.js T35.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n').join('\n      ')); }
}

function stripComments(src, file) {
  let s = src.replace(/<!--[\s\S]*?-->/g, '');
  if (/\.js$/.test(file)) {
    s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  }
  return s;
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (p === path.join(DOCS, 'pro') || ent.name === 'node_modules' || ent.name === 'vendor') continue;
      walk(p, out);
    } else if (/\.(html|js)$/.test(ent.name)) out.push(p);
  }
  return out;
}

// Every checkbox and the label that describes it (enclosing <label>, or
// <label for="id">).
function consentBlocks() {
  const blocks = [];
  for (const file of walk(DOCS, [])) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const src = stripComments(fs.readFileSync(file, 'utf8'), file);
    if (!/type=["']checkbox["']/.test(src)) continue;
    const inputRe = /<input\b[^>]*type=["']checkbox["'][^>]*>/g;
    let m;
    while ((m = inputRe.exec(src))) {
      const tag = m[0];
      const idm = tag.match(/\bid="([^"]+)"/);
      const id = idm ? idm[1] : '';
      let label = '';
      const open = src.lastIndexOf('<label', m.index);
      const close = src.lastIndexOf('</label>', m.index);
      if (open !== -1 && open > close) {
        label = src.slice(open, src.indexOf('</label>', m.index) + 8);
      } else if (id) {
        const fi = src.indexOf('<label for="' + id + '"');
        if (fi !== -1) label = src.slice(fi, src.indexOf('</label>', fi) + 8);
      }
      blocks.push({ file: rel, id, tag, label });
    }
  }
  // Only the boxes that cover texts.
  // Judged on the visible words, not the markup (attributes like
  // data-cp-terms-text are not a texting disclosure).
  return blocks.filter(b => /\btexts?\b|\bSMS\b|Reply STOP|data rates/i.test(labelText(b.label)));
}

function labelText(label) {
  return label.replace(/^<label[^>]*>/, '').replace(/<input\b[^>]*>/g, '').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

const SENTENCE = /^I agree to receive (.+?) from No Big Deal Home Solutions by call or text at the number above\. Message frequency varies\. Message & data rates may apply\. Reply STOP to opt out, HELP for help\. Consent is not a condition of purchase\. Privacy Policy$/;

// Each form keeps its own "what".
const EXPECTED = {
  'docs/inspect.html#ins-consent': 'my results and follow-up communication',
  'docs/storm-check.html#sc-consent': 'my results and follow-up communication',
  'docs/roof-score.html#rs-consent': 'my results and follow-up communication',
  'docs/storm-report.html#sr-consent': 'my results and follow-up communication',
  'docs/index.html#fieldConsent': 'my results and follow-up communication',
  "docs/assets/js/quick-lead-form.js#' + uid + '-consent": 'my results and follow-up communication',
  'docs/storm-alerts.html#sa-consent': 'storm alerts and follow-up communication',
  'docs/estimate.html#tcpaConsent': 'my estimate and follow-up communication',
};

console.log('\nSMS CONSENT — carrier A2P elements on every homeowner form\n' + '═'.repeat(64));

const blocks = consentBlocks();
const key = b => b.file + '#' + b.id;

check('A1 discovery finds every known consent block (guards against a vacuous pass)', () => {
  const found = new Set(blocks.map(key));
  for (const k of Object.keys(EXPECTED)) assert.ok(found.has(k), 'consent block not found: ' + k);
});

check('A2 no texting checkbox outside the known set (a new form must be added on purpose)', () => {
  const extra = blocks.map(key).filter(k => !(k in EXPECTED));
  assert.deepStrictEqual(extra, [], 'unexpected texting consent block(s) — add to EXPECTED after checking wording');
});

for (const b of blocks) {
  const k = key(b);
  check('A3 ' + k + ' reads the standard sentence with its own "what"', () => {
    const t = labelText(b.label);
    const m = t.match(SENTENCE);
    assert.ok(m, k + ': label is not the standard A2P sentence:\n' + t);
    if (EXPECTED[k]) assert.strictEqual(m[1], EXPECTED[k], k + ': the form\'s own "what" changed');
  });
  check('A4 ' + k + ' links the Privacy Policy SMS terms', () => {
    assert.ok(/<a href="\/privacy#sms-terms"[^>]*>Privacy Policy<\/a>/.test(b.label),
      k + ': missing <a href="/privacy#sms-terms">Privacy Policy</a>');
  });
  check('A5 ' + k + ' is unchecked by default', () => {
    assert.ok(!/\bchecked\b/.test(b.tag), k + ': consent checkbox is pre-checked: ' + b.tag);
  });
}

check('A6 /privacy#sms-terms states frequency, STOP and HELP', () => {
  const html = stripComments(fs.readFileSync(path.join(DOCS, 'privacy.html'), 'utf8'), 'privacy.html');
  const i = html.indexOf('id="sms-terms"');
  assert.ok(i > 0, '/privacy lost its #sms-terms anchor');
  const sec = html.slice(i, html.indexOf('</ul>', i));
  assert.ok(/message frequency varies/i.test(sec), '#sms-terms lacks "message frequency varies"');
  assert.ok(/reply STOP/i.test(sec), '#sms-terms lacks STOP');
  assert.ok(/Reply HELP/.test(sec), '#sms-terms lacks HELP');
});

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ' — ' + pass + ' passed, ' + fail + ' failed (' + blocks.length + ' consent blocks)');
process.exit(fail ? 1 : 0);
