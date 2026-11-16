/**
 * tests/ds-coach-disclaimer-2026-11-14.test.js
 *
 * Joe's decision (2026-11-14): the Workout Coach gets one short, plain line, "Not medical advice. Stop if something
 * hurts.", shown once at first use (until he taps "Got it") and always available in the coach's settings. The deload,
 * stall and readiness advice used to carry no such line (only the avoid list said "not medical advice").
 *
 * Run: node tests/ds-coach-disclaimer-2026-11-14.test.js
 */
'use strict';
const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }
const LINE = /Not medical advice\. Stop if something hurts\./;
const logger = (html) => html.split('class="wc-settings"')[0];   // the logger above any open settings panel

console.log('\n1. first use');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
  h.click('start');
  const html = h.html();
  ok('the line shows on the first workout', LINE.test(logger(html)), html.slice(0, 300));
  ok('...with a "Got it" button', /data-coach-action="note-ok"[^>]*>Got it</.test(html));
  ok('...and Close is still the first thing focus lands on (the note sits under the header)', html.indexOf('data-coach-action="close"') > -1 && html.indexOf('data-coach-action="close"') < html.indexOf('note-ok'));
  h.click('note-ok');
  ok('"Got it" hides it', !LINE.test(logger(h.html())));
  ok('...and remembers it in the coach settings (which sync to the other devices)', h.settings() && h.settings().noteSeen === true, JSON.stringify(h.settings()));
  const again = makeHarness({ storage: { nbd_ds_workouts: [], nbd_ds_coach: h.settings() }, today: '2026-11-15' });
  again.click('start');
  ok('the next workout does not show it again', !LINE.test(logger(again.html())));
  again.click('settings');
  ok('it is always in the coach settings', LINE.test(again.html()));
  const other = h.settings(); other.rotation = 'ul';
  const kept = makeHarness({ storage: { nbd_ds_workouts: [], nbd_ds_coach: other }, today: '2026-11-15' });
  kept.click('start'); kept.click('settings'); kept.click('set-warmups', { val: 'off' });
  ok('changing another setting keeps the "seen" mark', kept.settings().noteSeen === true && kept.settings().warmups === false, JSON.stringify(kept.settings()));
}

console.log('\n2. short and plain');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
  h.click('start');
  const m = h.html().match(/<div class="wc-safety-note"[^>]*>([\s\S]*?)<button/);
  const text = m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  ok('one sentence pair, under 60 characters', text.length > 0 && text.length < 60, JSON.stringify(text));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
