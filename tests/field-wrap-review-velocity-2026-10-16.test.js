#!/usr/bin/env node
/**
 * tests/field-wrap-review-velocity-2026-10-16.test.js — Field's end-of-day
 * wrap-up, and review velocity on the Needs-you reviews chip.
 *
 *   A. the wrap-up lines: stops, photos (never a false "all uploaded"), visits, tomorrow's first
 *   B. when and where it shows; a saved photo is counted for the day
 *   C. review velocity: asks waiting, Google reviews in 30 days (NBD's own profile, only when the read answered)
 *   D. the draft ask: a checked sms: draft, no incentive, no gating; Joe sends it
 *
 * Run: node tests/field-wrap-review-velocity-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// field.js mounts nothing at load: run it with a stub kit + engine to reach _wrapLines
function fieldApi() {
  const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  const win = { NBDLayoutKit: K, LayoutEngine: { implement() {} }, addEventListener() {} };
  const ctx = { window: win, document: { documentElement: { classList: { contains: () => false } } }, console, JSON, Math, Date, Object, Array, String, Number, Promise, setTimeout: () => 1, setInterval: () => 1, localStorage: { getItem: () => null, setItem() {} } };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/layouts/field.js'), ctx);
  return win.NBDFieldApp;
}

(async () => {
  console.log('\nA. the wrap-up lines');
  {
    const F = fieldApi();
    const W = F && F._wrapLines;
    ok('field.js exposes the pure wrap-up lines', typeof W === 'function');
    const a = W({ total: 4, done: 4, photos: 12, queued: 0, visits: 3, tomorrow: { timeLabel: '7:00 am', name: 'Ben Albright' } });
    ok('stops, photos all uploaded, visits, tomorrow first', a.join(' | ') === '4 of 4 stops done | 12 photos from this phone today · all uploaded | 3 visits recorded today | Tomorrow first: 7:00 am · Ben Albright', a.join(' | '));
    ok('photos still in the queue say so', /12 photos from this phone today · 2 still uploading/.test(W({ total: 1, done: 1, photos: 12, queued: 2 }).join('|')));
    ok('a queue that could not be read is never "all uploaded"', /upload status unknown, they are saved on this phone/.test(W({ total: 1, done: 1, photos: 3, queued: null }).join('|')) && !/all uploaded/.test(W({ total: 1, done: 1, photos: 3, queued: null }).join('|')));
    ok('no visit count known: the line is left off (not "0 visits")', !/visit/.test(W({ total: 1, done: 1, visits: null }).join('|')));
    ok('0 visits recorded is said when it is known', /0 visits recorded today/.test(W({ total: 1, done: 1, visits: 0 }).join('|')));
    ok('singulars read right', W({ total: 1, done: 1, photos: 1, queued: 0, visits: 1 }).join('|') === '1 of 1 stop done|1 photo from this phone today · all uploaded|1 visit recorded today');
  }

  console.log('\nB. when and where');
  {
    const f = read('docs/pro/js/layouts/field.js');
    ok('it shows once every stop is done (no current stop)', /if \(!current\) h \+= wrapHtml\(all\.length, doneN, d\);/.test(f));
    ok('a saved photo is counted for the day (nbd_field_day.photos)', /S\.shots \+= 1;\s*\n\s*var dd = day\(\); dd\.photos = \(dd\.photos \|\| 0\) \+ 1; saveDay\(dd\);/.test(f));
    ok('visits come from the visit recorder\'s own list, today only, discarded and part-2 rows left out', /R\.list\(\)/.test(f) && /r\.status !== 'discarded' && !r\.partOf && Number\(r\.startedAtMs\) >= start\.getTime\(\)/.test(f));
    ok('tomorrow\'s first is the Next stop card\'s read', /NS\.model\(\)/.test(f) && /tomorrow: m && m\.tomorrow/.test(f));
    ok('the wrap-up carries Record visit / Recent visits and is a Customize card', /K\.recordEntry\(\{ source: 'field-wrap'/.test(f) && /\{ id: 'wrap', label: 'Day wrap-up', sel: '\[data-fa-group="wrap"\]' \}/.test(read('docs/pro/js/card-prefs.js')));
  }

  console.log('\nC. review velocity on the chip');
  {
    const h = HA.stripHtml({ reviews: 2, reviews30: 3 });
    ok('asks waiting and Google reviews in the last 30 days', /⭐ 2 review asks waiting · 3 Google reviews in 30 days/.test(h), h);
    ok('one review reads right; unknown is left off', /1 Google review in 30 days/.test(HA.stripHtml({ reviews: 1, reviews30: 1 })) && !/Google review/.test(HA.stripHtml({ reviews: 1 })));
    const src = read('docs/pro/js/home-attention.js');
    ok('only for NBD\'s own Google profile (the /api/google-reviews endpoint is NBD\'s)', /const nbd = typeof w\._isNbdPlatformTenant === 'function' && w\._isNbdPlatformTenant\(\) === true;/.test(src) && /if \(nbd && ND/.test(src));
    ok('only when the Google read answered (an empty failure is not "0")', /ND\.reviewsOk\(\)/.test(src) && /function reviewsOk\(\) \{ return _reviewsOk; \}/.test(read('docs/pro/js/numbers-data.js')));
    ok('the count uses review time in seconds over 30 days', /const since = Date\.now\(\) \/ 1000 - 30 \* 86400;/.test(src));
  }

  console.log('\nD. the draft ask');
  {
    const body = HA.reviewAskBody('Dana', 'No Big Deal Home Solutions', 'https://nobigdealwithjoedeal.com/r');
    ok('a plain thank-you with the review link', body === 'Hi Dana, thank you for choosing No Big Deal Home Solutions for your project. If you have a minute, a Google review helps other homeowners find us: https://nobigdealwithjoedeal.com/r', body);
    ok('no incentive and no gating ("if you were happy", stars, a reward, a discount)', !/happy|satisf|5[ -]?star|five star|reward|discount|gift|\$|free|referral|enter|chance/i.test(body));
    const href = 'sms:+15135550100?&body=' + encodeURIComponent(body);
    const h = HA.stripHtml({ reviews: 1, reviewDraft: { leadId: 'L1', href } });
    ok('"Draft a review ask" is an sms: draft held by checkText (data-ps-check + the lead)', h.indexOf('<a class="ha-item" href="' + href + '" data-ps-check="1" data-ps-lead="L1">✍ Draft a review ask</a>') !== -1, h);
    ok('an unsafe or foreign href is never painted', !/javascript|Draft a review/.test(HA.stripHtml({ reviews: 1, reviewDraft: { leadId: 'L1', href: 'javascript:alert(1)' } })) && !/Draft a review/.test(HA.stripHtml({ reviews: 1, reviewDraft: { leadId: 'L1', href: 'sms:+15135550100?&body="><img>' } })));
    ok('a lead id cannot break out of its attribute', /data-ps-lead="L1scriptx"/.test(HA.stripHtml({ reviews: 1, reviewDraft: { leadId: 'L1"><script>x', href } })));
    ok('no asks waiting: no draft button', !/Draft a review/.test(HA.stripHtml({ reviews: 0, reviewDraft: { leadId: 'L1', href } })));
    const src = read('docs/pro/js/home-attention.js');
    ok('the draft goes to the newest paid-in-full customer the deck would ask (its own rule)', /reviewVelocity\(w\.NBDReviewDeck\.candidates\(w\._leads\)\[0\]\)/.test(src));
    ok('the link is the one every ask uses (ReviewEngine.getReviewLink, now exported)', /await RE\.getReviewLink\(\)/.test(src) && /getReviewLink: getReviewLink,/.test(read('docs/pro/js/review-engine.js')));
    ok('nothing is marked asked or sent by drafting', !/markAsked|sendReviewSMS|reviewRequested\s*[:=]/.test(src.slice(src.indexOf('async function reviewVelocity'), src.indexOf('async function count()'))));
    const dash = read('docs/pro/dashboard.html');
    ok('home-attention, numbers-data and review-engine were cache-busted', /home-attention\.js\?v=25/.test(dash) && /numbers-data\.js\?v=2/.test(dash) && /review-engine\.js\?v=11/.test(dash) && /review-engine\.js\?v=11/.test(read('docs/pro/customer.html')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
