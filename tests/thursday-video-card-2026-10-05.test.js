/**
 * tests/thursday-video-card-2026-10-05.test.js — "A video from Thursday" on
 * the homeowner deal room and the customer portal (Jo, 2026-10-05).
 *
 * Thursday is NBD's assistant presenter. The card is NBD-only and
 * config-driven (one VIDEOS entry per surface, so swapping a video is one
 * edit), under a plain label (Jo, 2026-10-05: no visible disclosure line), and
 * it ships DARK: no surface has a video until the follow-up video is produced.
 *
 * Pins:
 *   A. The card module (docs/pro/js/thursday-video.js), run in Node with a
 *      tiny fake DOM: hidden when not configured, hidden for non-NBD (and for a
 *      truthy-but-not-true isNbd), renders when configured; the player is
 *      controls + playsinline + preload="none" + poster, no autoplay / muted /
 *      loop, a WebVTT captions <track>, and a plain label. Only
 *      same-origin /assets/ paths configure a surface.
 *   B. The deal room: getDealRoom (functions/deal-acceptance.js) adds the
 *      marker + script and widens its CSP (that one script by exact path,
 *      media-src 'self') for an NBD deal ONLY; another tenant's deal page keeps
 *      the old policy byte-for-byte, so it cannot pull NBD's card in itself.
 *   C. The portal: the server sends company.isNbd from the tenant key (never
 *      the company name); portal.js gates on isNbd === true; portal.html loads
 *      the module before portal.js.
 *   D. Ships dark. Flip this pin in the PR that configures a video.
 *
 * Run: node tests/thursday-video-card-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

const TV = require(path.join(ROOT, 'docs/pro/js/thursday-video.js'));
const Gate = require(path.join(FUNCTIONS, 'thursday-video-gate.js'));
const { NBD_OWNER_UID } = require(path.join(FUNCTIONS, 'tenant-ops-logic.js'));

// ── tiny fake DOM ────────────────────────────────────────────────
function makeDoc() {
  const doc = {};
  function el(tag) {
    const e = {
      tagName: String(tag).toUpperCase(), attrs: {}, children: [], parentNode: null,
      ownerDocument: doc, className: '', textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (c.tagName === 'LINK' && c.onload) setImmediate(c.onload); return c; },
      insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
      replaceChild(n, o) { const i = this.children.indexOf(o); if (n.parentNode && n.parentNode !== this) { const pc = n.parentNode.children; pc.splice(pc.indexOf(n), 1); } this.children[i] = n; n.parentNode = this; o.parentNode = null; return o; },
      get firstChild() { return this.children[0] || null; },
    };
    return e;
  }
  doc.createElement = el;
  doc.head = el('head');
  doc.body = el('body');
  doc.documentElement = el('html');
  doc._all = () => { const out = []; const walk = (n) => { out.push(n); n.children.forEach(walk); }; walk(doc.head); walk(doc.body); return out; };
  doc.querySelector = (sel) => {
    const all = doc._all();
    if (sel === 'meta[name="nbd-thursday"]') return all.find((n) => n.tagName === 'META' && n.attrs.name === 'nbd-thursday') || null;
    if (sel === '.container') return all.find((n) => n.className === 'container') || null;
    if (sel === 'link[data-thursday-css]') return all.find((n) => n.tagName === 'LINK' && n.attrs['data-thursday-css']) || null;
    return null;
  };
  return doc;
}
const find = (root, tag) => { const out = []; const walk = (n) => { if (n.tagName === tag) out.push(n); n.children.forEach(walk); }; walk(root); return out; };
const tick = () => new Promise((r) => setImmediate(r));

const CONFIGURED = {
  dealRoom: { src: '/assets/video/thursday-followup-v1.mp4', poster: '/assets/img/thursday-followup-poster.webp', captions: '/assets/video/thursday-followup-v1.en.vtt' },
  portal: { src: '/assets/video/thursday-followup-v1.mp4', poster: '/assets/img/thursday-followup-poster.webp', captions: '/assets/video/thursday-followup-v1.en.vtt' },
};

(async () => {
  console.log('A. card module');
  ok('plain default label names Thursday', /Thursday/.test(TV.LABEL), TV.LABEL);

  ok('hidden when not configured (NBD)', TV.shouldShow('portal', true, { portal: null }) === false);
  ok('hidden when only some fields are configured', TV.shouldShow('portal', true, { portal: { src: CONFIGURED.portal.src } }) === false);
  ok('hidden for a non-NBD tenant even when configured', TV.shouldShow('portal', false, CONFIGURED) === false);
  ok('hidden for a truthy-but-not-true isNbd ("true", 1)',
    TV.shouldShow('portal', 'true', CONFIGURED) === false && TV.shouldShow('portal', 1, CONFIGURED) === false);
  ok('hidden for an unknown surface', TV.shouldShow('toString', true, CONFIGURED) === false);
  ok('a third-party or protocol-relative URL never configures a surface',
    TV.configFor('portal', { portal: Object.assign({}, CONFIGURED.portal, { src: 'https://evil.test/x.mp4' }) }) === null
    && TV.configFor('portal', { portal: Object.assign({}, CONFIGURED.portal, { poster: '//evil.test/p.webp' }) }) === null
    && TV.configFor('portal', { portal: Object.assign({}, CONFIGURED.portal, { captions: 'javascript:alert(1)' }) }) === null);
  ok('renders for NBD when configured', TV.shouldShow('portal', true, CONFIGURED) === true && TV.shouldShow('dealRoom', true, CONFIGURED) === true);

  {
    const doc = makeDoc();
    const card = TV.buildCard(doc, 'portal', CONFIGURED);
    const [video] = find(card, 'VIDEO');
    const [track] = find(card, 'TRACK');
    const [source] = find(card, 'SOURCE');
    const ps = find(card, 'P');
    ok('builds a <video> with controls + playsinline', !!video && video.hasAttribute('controls') && video.hasAttribute('playsinline'));
    ok('preload="none" and a poster', video && video.getAttribute('preload') === 'none' && video.getAttribute('poster') === CONFIGURED.portal.poster);
    ok('never autoplays, never muted, never loops',
      video && !video.hasAttribute('autoplay') && !video.hasAttribute('muted') && !video.hasAttribute('loop'));
    ok('reserves its box (width/height → no layout shift)', video && video.getAttribute('width') === '540' && video.getAttribute('height') === '960');
    ok('mp4 <source> from config', source && source.getAttribute('src') === CONFIGURED.portal.src && source.getAttribute('type') === 'video/mp4');
    ok('WebVTT captions <track kind="captions" srclang="en">',
      track && track.getAttribute('kind') === 'captions' && track.getAttribute('srclang') === 'en' && track.getAttribute('src') === CONFIGURED.portal.captions);
    const labels = card.children.filter((c) => c.className === 'thv-label');
    ok('shows the plain label above the player', labels.length === 1 && labels[0].textContent === TV.LABEL && card.getAttribute('aria-label') === TV.LABEL);
    const card2 = TV.buildCard(doc, 'portal', { portal: Object.assign({ label: 'A quick look at your free inspection' }, CONFIGURED.portal) });
    ok('a configured label overrides the default', card2.children[0].textContent === 'A quick look at your free inspection');
    ok('no extra visible text block beside label + player', ps.length === 0 && card.children.length === 2);
    ok('buildCard returns null when not configured', TV.buildCard(doc, 'portal', { portal: null }) === null);
  }

  {
    const src = stripJsComments(read('docs/pro/js/thursday-video.js'));
    ok('module has no innerHTML / inline handler attributes / autoplay',
      !/innerHTML|setAttribute\(\s*['"]on|autoplay|\.muted\s*=/.test(src));
  }

  // mountInto: re-renders move the SAME node (no mid-play teardown)
  {
    const doc = makeDoc();
    const main = doc.createElement('main'); doc.body.appendChild(main);
    const slot1 = doc.createElement('div'); main.appendChild(slot1);
    const r1 = TV.mountInto(slot1, 'portal', true, CONFIGURED);
    await tick(); await tick();
    const card1 = main.children[0];
    ok('mountInto renders into the slot for NBD', r1 === true && card1 && card1.attrs['data-thursday-video'] === 'portal');
    ok('links the card stylesheet once', find(doc.head, 'LINK').length === 1);
    main.children = []; const slot2 = doc.createElement('div'); main.appendChild(slot2);
    TV.mountInto(slot2, 'portal', true, CONFIGURED);
    ok('a re-render reuses the same card node', main.children[0] === card1);
    const docB = makeDoc(); const slotB = docB.createElement('div'); docB.body.appendChild(slotB);
    ok('mountInto refuses a non-NBD tenant', TV.mountInto(slotB, 'portal', false, CONFIGURED) === false && docB.body.children[0] === slotB);
  }

  // autoMountDealRoom: marker meta required
  {
    const doc = makeDoc();
    const c = doc.createElement('div'); c.className = 'container'; doc.body.appendChild(c);
    ok('deal room: no marker meta → nothing', TV.autoMountDealRoom(doc, CONFIGURED) === false && c.children.length === 0);
    const meta = doc.createElement('meta'); meta.setAttribute('name', 'nbd-thursday'); meta.setAttribute('content', '1'); doc.head.appendChild(meta);
    ok('deal room: marker but not configured → nothing', TV.autoMountDealRoom(doc, { dealRoom: null }) === false && c.children.length === 0);
  }

  console.log('B. deal room (getDealRoom)');
  ok('isNbdTenant: NBD owner uid only',
    Gate.isNbdTenant(NBD_OWNER_UID) === true && Gate.isNbdTenant('someOtherTenantUid') === false
    && Gate.isNbdTenant('') === false && Gate.isNbdTenant(null) === false && Gate.isNbdTenant({}) === false);

  const TOKEN = 'b'.repeat(32);
  const PAGE = '<!doctype html><html><head><title>Deal</title></head><body><div class="container"></div></body></html>';
  let stubs = null;
  const realLoad = Module._load;
  Module._load = function (request) {
    if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.apply(this, arguments);
  };
  function makeStubs(docs) {
    const docRef = (p) => ({
      get: async () => ({ exists: docs[p] != null, data: () => docs[p], get: (k) => (docs[p] || {})[k] }),
      update: async () => {}, set: async () => {},
    });
    const db = { doc: docRef, collection: (n) => ({ doc: (id) => docRef(n + '/' + id) }) };
    const noop = () => {};
    return {
      'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError: class extends Error {} },
      'firebase-functions/v2': { logger: { info: noop, warn: noop, error: noop } },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n }, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
      'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file: () => ({ download: async () => [Buffer.from(PAGE)] }) }) }) },
      './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
      './integrations/_shared': { secretOr: (s, d) => d },
      './shared': { callableRateLimit: async () => {}, assertNotViewer: noop },
      './deal-install-date': { fillLeadInstallDate: async () => {} },
      './push-functions': {},
    };
  }
  function parseCsp(v) {
    const out = {};
    String(v || '').split(';').map((s) => s.trim()).filter(Boolean).forEach((d) => { const [n, ...vals] = d.split(/\s+/); out[n.toLowerCase()] = vals; });
    return out;
  }
  async function serve(companyId) {
    stubs = makeStubs({
      ['deal_accept_tokens/' + TOKEN]: { status: 'pending', dealId: 'd1', ownerUid: companyId, companyId, htmlPath: 'deal_rooms/u/d1.html', expiresAt: { toMillis: () => Date.now() + 1e6 } },
      'deal_rooms/d1': { status: 'sent' },
    });
    delete require.cache[path.join(FUNCTIONS, 'deal-acceptance.js')];
    const mod = require(path.join(FUNCTIONS, 'deal-acceptance.js'));
    const res = { statusCode: 200, headers: {}, body: undefined };
    res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.end = () => res;
    await mod.getDealRoom.__handler({ path: '/deal/' + TOKEN, get: () => 'Mozilla/5.0 (iPhone)', headers: {} }, res);
    return res;
  }
  try {
    const nbd = await serve(NBD_OWNER_UID);
    const other = await serve('otherTenantUid123');
    const cN = parseCsp(nbd.headers['content-security-policy']);
    const cO = parseCsp(other.headers['content-security-policy']);
    const body = String(nbd.body);
    ok('NBD deal: marker meta + card script injected in <head>',
      body.includes('<meta name="nbd-thursday" content="1">') && /<script src="\/pro\/js\/thursday-video\.js\?v=\d+" defer><\/script><\/head>/.test(body), body.slice(0, 600));
    const sN = (cN['script-src'] || []).concat(cN['script-src-elem'] || []);
    ok('NBD deal CSP: scripts are deal-room.js + thursday-video.js by exact path only',
      sN.length > 0 && sN.every((s) => /^https:\/\/[a-z.-]+\/pro\/(deal-room\.js|js\/thursday-video\.js)$/.test(s)) && sN.some((s) => /thursday-video/.test(s)), sN.join(' '));
    ok("NBD deal CSP: media-src 'self' only", (cN['media-src'] || []).join(' ') === "'self'", JSON.stringify(cN['media-src']));
    ok("NBD deal CSP keeps default-src 'none', form-action 'none', connect-src 'self'",
      (cN['default-src'] || []).join(' ') === "'none'" && (cN['form-action'] || []).join(' ') === "'none'" && (cN['connect-src'] || []).join(' ') === "'self'");
    ok('other tenant: no marker, no card script', !String(other.body).includes('nbd-thursday') && !String(other.body).includes('thursday-video.js'));
    const sO = (cO['script-src'] || []).concat(cO['script-src-elem'] || []);
    ok('other tenant CSP: deal-room.js only, no media-src',
      sO.length > 0 && sO.every((s) => /^https:\/\/[a-z.-]+\/pro\/deal-room\.js$/.test(s)) && !('media-src' in cO), other.headers['content-security-policy']);
  } finally {
    stubs = null; Module._load = realLoad;
  }

  console.log('C. portal');
  {
    const server = stripJsComments(read('functions/portal.js'));
    ok('server sends company.isNbd from the tenant key', /isNbd:\s*ThursdayGate\.isNbdTenant\(tenantKey\)/.test(server));
    const client = stripJsComments(read('docs/pro/js/portal.js'));
    ok('portal.js gates the card on company.isNbd === true (not the name)',
      /view\.company\.isNbd === true/.test(client) && /TV\.shouldShow\('portal', thursdayIsNbd\)/.test(client) && /TV\.mountInto\(thursdaySlot, 'portal', thursdayIsNbd\)/.test(client));
    const html = read('docs/pro/portal.html').replace(/<!--[\s\S]*?-->/g, ' ');
    const iTv = html.search(/<script defer src="js\/thursday-video\.js\?v=\d+"><\/script>/);
    const iPortal = html.search(/<script src="js\/portal\.js\?v=\d+" defer><\/script>/);
    ok('portal.html loads thursday-video.js before portal.js', iTv > 0 && iPortal > iTv, iTv + ' / ' + iPortal);
    ok('card CSS exists for both skins', /\.thv--deal\b/.test(read('docs/pro/css/thursday-video.css')) && /\.thv--portal\b/.test(read('docs/pro/css/thursday-video.css')));
  }

  console.log('D. ships dark');
  ok('no surface has a video configured yet (flip in the PR that adds one)',
    TV.VIDEOS.dealRoom === null && TV.VIDEOS.portal === null && TV.shouldShow('dealRoom', true) === false && TV.shouldShow('portal', true) === false);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
