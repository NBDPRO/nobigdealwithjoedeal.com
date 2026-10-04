#!/usr/bin/env node
/**
 * Proposal views (2026-10-02): "opened 3 times, 12 min read" + a heads-up to
 * the rep when the homeowner opens the deal.
 *
 *   A. deal-view-logic.js: preview bots, read-time clamp, when to notify,
 *      the message.
 *   B. getDealRoom: bots are served but never counted; a real open stamps
 *      viewed + viewCount + lastViewedAt and asks notifyDealView, which claims
 *      the heads-up in a transaction (one ping for two near-simultaneous opens).
 *   C. dealRoomReadPing: same-origin rewrite, token-checked, clamped,
 *      update() (never recreates a removed deal room).
 *   D. deal-room.js reports visible time only, on hide/close, via sendBeacon,
 *      and only on a served deal (token + read URL).
 *   E. Close Board shows "👁 Viewed 3× · 12 min".
 *
 * Run: node tests/deal-room-views-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const DV = require(path.join(ROOT, 'functions', 'deal-view-logic.js'));

console.log('A. rules');
{
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  ok('a real iPhone / desktop browser is a view', !DV.isPreviewBot(IPHONE) && !DV.isPreviewBot(CHROME));
  ok('iMessage / Messenger / Slack / WhatsApp previews are not',
    ['facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'WhatsApp/2.23.20.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)', ''].every(DV.isPreviewBot));
  ok('read seconds: clamped to 0..900, junk is 0', DV.clampReadSeconds(42.9) === 42 && DV.clampReadSeconds(99999) === DV.MAX_PING_SECONDS && DV.clampReadSeconds(-5) === 0 && DV.clampReadSeconds('x') === 0);
  const now = Date.parse('2026-10-02T20:00:00Z');
  ok('first open notifies', DV.shouldNotifyView({ viewCount: 0 }, now) && DV.shouldNotifyView({}, now));
  ok('a re-open within 6 h does not', !DV.shouldNotifyView({ viewCount: 2, lastViewNotifiedAt: { toMillis: () => now - 3600e3 } }, now));
  ok('a re-open 6 h+ later does', DV.shouldNotifyView({ viewCount: 2, lastViewNotifiedAt: { toMillis: () => now - 7 * 3600e3 } }, now));
  const m1 = DV.viewMessage('Maria Lopez', 1, 0), m3 = DV.viewMessage('Maria Lopez', 3, 720);
  ok('first-open message', m1.title === 'Proposal opened 👀' && m1.body === 'Maria Lopez just opened their proposal.', JSON.stringify(m1));
  ok('re-open message carries the count and read time', m3.body === 'Maria Lopez opened their proposal again (3 times, 12 min read so far).', m3.body);
  ok('no name → "Your customer"', /^Your customer/.test(DV.viewMessage('', 1).body));
}

const src = read('functions/deal-acceptance.js');
const getBody = src.slice(src.indexOf('exports.getDealRoom = onRequest('), src.indexOf('exports.submitDealAcceptance = onRequest('));

console.log('B. getDealRoom');
{
  const botAt = getBody.indexOf('const isBot = DV.isPreviewBot(req.get(\'user-agent\'));');
  const gateAt = getBody.indexOf('if (!isBot) {');
  ok('bot check runs before any stamp', botAt > 0 && gateAt > botAt && getBody.indexOf("status: 'viewed'") > gateAt && getBody.indexOf('deal_accept_tokens/${token}`).update(') > gateAt);
  ok('a real open increments viewCount and stamps lastViewedAt on the deal room', /status: 'viewed', viewedAt: FieldValue\.serverTimestamp\(\),\s*viewCount: FieldValue\.increment\(1\), lastViewedAt: FieldValue\.serverTimestamp\(\) \}\)/.test(getBody));
  ok('…and asks notifyDealView, never awaited (the page never waits on it)', /notifyDealView\(db, tok, dealRoomSnap\.data\(\) \|\| \{\}\)\.catch\(/.test(getBody));
  ok('the read URL is injected for the page', /<meta name="nbd-deal-read" content="\$\{escAttr\(READ_PATH\)\}">/.test(getBody) && /const READ_PATH = '\/api\/deal-read';/.test(src));
  const nd = src.slice(src.indexOf('async function notifyDealView('), src.indexOf('exports.dealRoomReadPing'));
  ok('notifyDealView claims the heads-up inside a transaction before sending', /runTransaction[\s\S]*tx\.update\(ref, \{ lastViewNotifiedAt: FieldValue\.serverTimestamp\(\) \}\)/.test(nd) && nd.indexOf('runTransaction') < nd.indexOf("collection('notifications').add"));
  ok('…writes the bell notification and pushes to the owner', /type: 'deal_viewed'/.test(nd) && /sendCustomNotification\(ownerUid,/.test(nd));
}

console.log('C. dealRoomReadPing');
{
  const ping = src.slice(src.indexOf('exports.dealRoomReadPing'));
  ok('POST only, rate-limited, token charset-checked', /req\.method !== 'POST'/.test(ping) && /httpRateLimit\(req, res, 'dealread-ping:ip'/.test(ping) && /\^\[A-Za-z0-9\]\{10,64\}\$/.test(ping));
  ok('seconds clamped; bots ignored', /DV\.clampReadSeconds\(b\.seconds\)/.test(ping) && /DV\.isPreviewBot\(req\.get\('user-agent'\)\)/.test(ping));
  ok('update() with increment — never set(merge), never recreates a removed room', /\.update\(\{ readSeconds: FieldValue\.increment\(seconds\) \}\)/.test(ping) && !/\.set\(/.test(ping));
  const fb = JSON.parse(read('firebase.json'));
  const rw = (fb.hosting.rewrites || []).find((r) => r.source === '/api/deal-read');
  ok('same-origin hosting rewrite → dealRoomReadPing', rw && rw.function && rw.function.functionId === 'dealRoomReadPing');
}

console.log('D. deal-room.js beacon');
{
  function run(metas, visibility) {
    const beacons = [];
    const listeners = {};
    const doc = {
      visibilityState: visibility,
      getElementById: () => null,
      querySelector: (q) => { const m = /meta\[name="([^"]+)"\]/.exec(q); return m && metas[m[1]] ? { getAttribute: () => metas[m[1]], content: metas[m[1]] } : null; },
      querySelectorAll: () => [],
      addEventListener: (t, fn) => { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(fn); },
    };
    let now = 1000000;
    const win = { addEventListener: (t, fn) => { (listeners['win:' + t] = listeners['win:' + t] || []).push(fn); } };
    const ctx = vm.createContext({
      window: win, document: doc, console, JSON,
      navigator: { sendBeacon: (url, blob) => { beacons.push({ url, body: blob.__text }); return true; } },
      Blob: function (parts) { this.__text = parts.join(''); },
      Date: { now: () => now },
    });
    vm.runInContext(read('docs/pro/deal-room.js'), ctx);
    return { beacons, fire: (k) => (listeners[k] || []).forEach((f) => f()), tick: (ms) => { now += ms; }, doc };
  }
  const t = run({ 'nbd-deal-token': 'TOKEN12345', 'nbd-deal-read': '/api/deal-read' }, 'visible');
  t.tick(95000); t.doc.visibilityState = 'hidden'; t.fire('doc:visibilitychange');
  ok('hiding the page reports the visible seconds', t.beacons.length === 1 && t.beacons[0].url === '/api/deal-read' && JSON.parse(t.beacons[0].body).seconds === 95 && JSON.parse(t.beacons[0].body).token === 'TOKEN12345', JSON.stringify(t.beacons));
  t.tick(600000); t.fire('win:pagehide');
  ok('time while hidden is not counted', t.beacons.length === 1);
  t.doc.visibilityState = 'visible'; t.fire('doc:visibilitychange'); t.tick(30000); t.fire('win:pagehide');
  ok('coming back counts again, and closing reports it', t.beacons.length === 2 && JSON.parse(t.beacons[1].body).seconds === 30);
  const p = run({}, 'visible');
  p.tick(60000); p.fire('win:pagehide');
  ok('the rep\'s in-app preview (no token) reports nothing', p.beacons.length === 0);
}

console.log('E. Close Board');
{
  const cb = read('docs/pro/js/close-board.js');
  const fn = cb.slice(cb.indexOf('function viewBadge(d)'), cb.indexOf('function viewTitle(d)'));
  const viewBadge = new Function(fn + '; return viewBadge;')();
  ok('"👁 Viewed 3× · 12 min"', viewBadge({ viewCount: 3, readSeconds: 720 }) === '👁 Viewed 3× · 12 min', viewBadge({ viewCount: 3, readSeconds: 720 }));
  ok('an older deal with only viewedAt reads "👁 Viewed"', viewBadge({ viewedAt: {} }) === '👁 Viewed');
  ok('one open, 40 sec', viewBadge({ viewCount: 1, readSeconds: 40 }) === '👁 Viewed · 40 sec');
  // ?v=2 shipped the beacon; later bumps (v=3: the financing band) keep it.
  const _drv = /pro\/deal-room\.js\?v=(\d+)/.exec(cb);
  ok('new deal pages load deal-room.js ?v=2+ (the beacon)', !!_drv && Number(_drv[1]) >= 2);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
