#!/usr/bin/env node
/**
 * tests/review-handoff-2026-10-16.test.js — the "Job done" hand-off screen
 * (docs/pro/js/review-handoff.js) and the in-page QR encoder (qr-code.js).
 *
 *   A. the QR decodes back to the review link: this file's OWN reader (format
 *      bits + BCH check, unmask, zigzag read, de-interleave, Reed-Solomon
 *      syndromes all zero, byte-mode parse), versions 1-10, every ECC level
 *   B. the SVG: dark on white, a quiet zone, no URL to fetch, no script
 *   C. the photo pick is the review email's (functions/review-ask-photo.js)
 *      on the same fixtures, and never another lead's / tenant's / job's photo
 *   D. the link: the rep's own, else NBD's for NBD, else the tenant's own;
 *      never NBD's for another company; no maps-search fallback QR
 *   E. the card: no rating, no gating, no incentive; escaped; an honest line
 *      when no link is set; one "Open review page" link (new tab, noopener)
 *   F. when it shows (Install Done or later) and where it is wired:
 *      customer.html, Field's bar / lead screen / wrap-up; CSP-safe, ?v= tags
 *
 * Run: node tests/review-handoff-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const Q = require(path.join(ROOT, 'docs/pro/js/qr-code.js'));
const H = require(path.join(ROOT, 'docs/pro/js/review-handoff.js'));
const RP = require(path.join(ROOT, 'functions/review-ask-photo.js'));
const RA = require(path.join(ROOT, 'functions/review-ask-auto-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// ── an independent QR reader (ISO/IEC 18004), byte mode only ──────────────
const EC_TABLE = {   // [ecc codewords per block, blocks] by ECC level, versions 1..10
  L: [[7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4]],
  M: [[10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]],
  Q: [[13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8]],
  H: [[17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8]],
};
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const TOTAL_CW = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
function gexp() { const e = [], l = []; let x = 1; for (let i = 0; i < 255; i++) { e[i] = x; l[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; } for (let i = 255; i < 512; i++) e[i] = e[i - 255]; return { e, l }; }
const GF = gexp();
const gmul = (a, b) => (a && b ? GF.e[GF.l[a] + GF.l[b]] : 0);
function syndromesZero(block, nEcc) {
  for (let i = 0; i < nEcc; i++) {
    let s = 0; const a = GF.e[i];
    for (const c of block) s = gmul(s, a) ^ c;
    if (s !== 0) return false;
  }
  return true;
}
function decodeQr(m) {
  const size = m.length, ver = (size - 17) / 4;
  if (!Number.isInteger(ver) || ver < 1 || ver > 10) throw new Error('bad size ' + size);
  // format bits, first copy (around the top-left finder)
  const fb = [];
  for (let i = 0; i <= 5; i++) fb.push(m[i][8]);
  fb.push(m[7][8], m[8][8], m[8][7]);
  for (let i = 9; i < 15; i++) fb.push(m[8][14 - i]);
  let raw = 0; fb.forEach((b, i) => { if (b) raw |= 1 << i; });
  const fmt = raw ^ 0x5412;
  let rem = fmt >>> 10; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  if (((fmt >>> 10) << 10 | (rem & 0x3FF)) !== fmt) throw new Error('format BCH mismatch');
  const ecl = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[(fmt >>> 13) & 3];
  const mask = (fmt >>> 10) & 7;
  // second copy must agree
  const fb2 = [];
  for (let i = 0; i < 8; i++) fb2.push(m[8][size - 1 - i]);
  for (let i = 8; i < 15; i++) fb2.push(m[size - 15 + i][8]);
  let raw2 = 0; fb2.forEach((b, i) => { if (b) raw2 |= 1 << i; });
  if (raw2 !== raw) throw new Error('format copies differ');
  if (!m[size - 8][8]) throw new Error('dark module missing');
  // function modules
  const fn = m.map((row) => row.map(() => false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c);
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  const ap = ALIGN[ver - 1];
  for (const r of ap) for (const c of ap) {
    if ((r === 6 && c === 6) || (r === 6 && c === ap[ap.length - 1]) || (r === ap[ap.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (ver >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(i, size - 11 + j); mark(size - 11 + j, i); }
  const masked = (r, c) => {
    const x = c, y = r;
    return [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x * y) % 2 + (x * y) % 3 === 0, ((x * y) % 2 + (x * y) % 3) % 2 === 0, ((x + y) % 2 + (x * y) % 3) % 2 === 0][mask];
  };
  const bits = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const c of [col, col - 1]) if (!fn[r][c]) bits.push(m[r][c] !== masked(r, c) ? 1 : 0);
    }
    up = !up;
  }
  const total = TOTAL_CW[ver - 1];
  const cws = [];
  for (let i = 0; i < total; i++) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]; cws.push(b); }
  const [nEcc, nBlocks] = EC_TABLE[ecl][ver - 1];
  const dataTotal = total - nEcc * nBlocks;
  const shortData = Math.floor(dataTotal / nBlocks), longCount = dataTotal % nBlocks, shortCount = nBlocks - longCount;
  const blocks = [];
  for (let b = 0; b < nBlocks; b++) blocks.push({ data: [], ecc: [], len: shortData + (b >= shortCount ? 1 : 0) });
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) for (const bl of blocks) if (i < bl.len) bl.data.push(cws[k++]);
  for (let i = 0; i < nEcc; i++) for (const bl of blocks) bl.ecc.push(cws[k++]);
  const rsOk = blocks.every((bl) => syndromesZero(bl.data.concat(bl.ecc), nEcc));
  const data = blocks.reduce((a, bl) => a.concat(bl.data), []);
  const dbits = []; data.forEach((b) => { for (let j = 7; j >= 0; j--) dbits.push((b >>> j) & 1); });
  let p = 0; const take = (n) => { let v = 0; for (let j = 0; j < n; j++) v = (v << 1) | dbits[p++]; return v; };
  const mode = take(4);
  if (mode !== 4) throw new Error('not byte mode: ' + mode);
  const len = take(ver < 10 ? 8 : 16);
  const bytes = []; for (let j = 0; j < len; j++) bytes.push(take(8));
  return { text: Buffer.from(bytes).toString('utf8'), ecl, mask, ver, rsOk };
}

(async () => {
  console.log('A. the QR decodes back to the link');
  {
    const URL = 'https://g.page/r/CXzIjLwvtRPdEBM/review';
    const q = Q.encode(URL);
    let d = null; try { d = decodeQr(q.modules); } catch (e) { d = { err: e.message }; }
    ok('the review link reads back exactly, Reed-Solomon clean', d && d.text === URL && d.rsOk === true, JSON.stringify(d));
    ok('error correction M by default, the smallest version that fits (3)', q.ecl === 'M' && d.ecl === 'M' && q.version === 3 && q.size === 29);
    ok('the mask in the format bits is the one the encoder chose', d.mask === q.mask);
    const cases = [['hello', 'L'], ['x'.repeat(150), 'M'], ['Ünïcødé ✓ https://example.com/?a=1&b=2', 'Q'], ['https://g.page/r/CXzIjLwvtRPdEBM/review', 'H'], ['A'.repeat(200), 'M']];
    const res = cases.map(([t, e]) => { try { const qq = Q.encode(t, { ecl: e }); const dd = decodeQr(qq.modules); return dd.text === t && dd.rsOk && dd.ecl === e ? 'ok' : 'bad v' + qq.version; } catch (err) { return err.message; } });
    ok('other lengths, UTF-8 and every ECC level decode too (versions 1-10, version info at 7+)', res.every((r) => r === 'ok'), res.join());
    let threw = ''; try { Q.encode('x'.repeat(400)); } catch (e) { threw = e.message; }
    ok('too long for version 10 → a clear error, not a broken code', threw === 'qr_too_long');
  }

  console.log('B. the SVG');
  {
    const s = Q.svg('https://g.page/r/CXzIjLwvtRPdEBM/review', { label: 'QR code for the Google review page' });
    ok('one inline SVG: a white square and black modules', /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 37 37"/.test(s) && /<rect width="37" height="37" fill="#FFFFFF"\/>/.test(s) && /<path d="M[^"]+" fill="#000000"\/><\/svg>$/.test(s), s.slice(0, 200));
    const xy = [...s.matchAll(/M(\d+),(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    ok('a 4-module quiet zone (29 + 8 = 37): every dark module sits inside 4..32', xy.length > 100 && xy.every(([x, y]) => x >= 4 && y >= 4 && x <= 32 && y <= 32));
    ok('nothing to fetch and nothing to run (no href, no src, no script)', !/href|src=|<script|xlink|https?:\/\/(?!www\.w3\.org)/.test(s));
    ok('the label is escaped', !/</.test(Q.svg('a', { label: '"><script>' }).slice(1).split('aria-label="')[1].split('"')[0]));
  }

  console.log('C. the photo pick is the email\'s');
  {
    const lead = { userId: 'u1', companyId: 'c1' };
    const P = (id, o) => Object.assign({ id, leadId: 'L1', userId: 'u1', companyId: 'c1', storagePath: 'photos/u1/' + id + '.jpg', url: 'https://firebasestorage.googleapis.com/v0/b/x/o/' + id + '?alt=media&token=t' }, o);
    const fixtures = [
      [P('b1', { phase: 'Before', capturedAt: 1000, location: 'Front slope' }), P('b2', { phase: 'Before', capturedAt: 900, location: 'Back' }), P('a1', { phase: 'After', capturedAt: 5000, location: 'Front slope, east' }), P('a2', { phase: 'After', capturedAt: 6000 })],
      [P('a1', { tags: ['completed_work'], capturedAt: 10 }), P('a2', { tags: ['after'], capturedAt: 20 })],
      [P('b1', { phase: 'before' })],
      [P('b1', { phase: 'Before', createdAt: 5 }), P('a1', { phase: 'After', createdAt: 9 }), P('x', { phase: 'During' })],
      [],
    ];
    const key = (pk) => (pk ? pk.kind + ':' + (pk.before ? pk.before.id : '') + ':' + pk.after.id : 'none');
    const same = fixtures.map((f) => key(H._pickPhotos(f)) === key(RP.pickPhotos(f)));
    ok('same pick as review-ask-photo.js on every fixture (pair by location, single After, a lone Before is never shown, none)', same.every(Boolean), fixtures.map((f) => key(H._pickPhotos(f)) + ' vs ' + key(RP.pickPhotos(f))).join(' | '));
    ok('the location pair wins (Front slope before + Front slope after)', key(H._pickPhotos(fixtures[0])) === 'pair:b1:a1');
    const mixed = [P('ok'), P('lead2', { leadId: 'L2' }), P('tenant2', { userId: 'u9', companyId: 'c9' }), P('del', { deleted: true }), P('hid', { hidden: true }),
      P('job2', { jobId: 'j2' }), P('vid', { storagePath: 'photos/u1/v.mov' }), P('mime', { mimeType: 'video/mp4' }), P('nourl', { url: 'http://insecure/x.jpg' }), P('jobme', { jobId: 'j1' })];
    const elig = H._eligiblePhotos(lead, 'L1', 'j1', mixed).map((p) => p.id).sort().join();
    ok('only this lead, this tenant, live, this job (or none), an image with an https link', elig === 'jobme,ok', elig);
    const srv = RP.eligiblePhotos(lead, 'L1', 'j1', mixed.filter((p) => p.id !== 'nourl')).map((p) => p.id).sort().join();
    ok('the same filter the email uses (before the email\'s Storage owner check)', srv === elig, srv + ' vs ' + elig);
    const shared = H._eligiblePhotos(lead, 'L1', null, [P('s', { sharedWithHomeowner: true }), P('n')]).map((p) => p.id).join();
    ok('when any photo is shared with the homeowner, only shared ones', shared === 's');
    ok('an annotated photo shows its clean original', H._displayUrlOf(P('z', { isAnnotated: true, originalUrl: 'https://x/orig.jpg' })) === 'https://x/orig.jpg');
    ok('no lead id → nothing', H._eligiblePhotos(lead, '', null, mixed).length === 0);
  }

  console.log('D. the link');
  {
    const NBD = 'https://g.page/r/CXzIjLwvtRPdEBM/review';
    ok('NBD\'s link is the automatic email\'s', H.NBD_REVIEW_URL === NBD && RA.NBD_REVIEW_URL === NBD);
    ok('the rep\'s own https link first', H._pickReviewUrl('https://g.page/r/rep/review', true, '') === 'https://g.page/r/rep/review');
    ok('NBD with no rep link → NBD\'s', H._pickReviewUrl('', true, 'https://other/x') === NBD);
    ok('another company → its own link, never NBD\'s', H._pickReviewUrl('', false, 'https://g.page/r/acme/review') === 'https://g.page/r/acme/review' && H._pickReviewUrl('', false, '') === '');
    ok('a maps search (ReviewEngine\'s last resort) is not a review page: no QR for it', H._pickReviewUrl('', false, 'https://www.google.com/maps/search/Acme') === '');
    ok('http / javascript links are refused', H._pickReviewUrl('http://x', false, 'javascript:alert(1)') === '');
  }

  console.log('E. the card');
  {
    const lead = { firstName: 'Dana<script>' };
    const qr = Q.svg(H.NBD_REVIEW_URL);
    const html = H._cardHtml({ lead, word: 'roof', company: 'No Big Deal Home Solutions', pick: { kind: 'pair', before: { url: 'https://x/b.jpg' }, after: { url: 'https://x/a.jpg' } }, qrSvg: qr, url: H.NBD_REVIEW_URL });
    const text = html.replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, ' ');
    ok('thanks them, shows before and after, and asks the same plain question', /Thank you, Dana&lt;script&gt;!/.test(html) && /before and after/.test(text) && /Would you leave No Big Deal Home Solutions a Google review\? Honest feedback, whatever it is, helps your neighbors pick a contractor\./.test(text), text);
    ok('no rating first, no gating, no incentive', !/happy|satisf|star|rate|rating|reward|discount|gift|\$|free|enter|chance|coupon|raffle|5\b/i.test(text), text);
    ok('one "Open review page" link: new tab, noopener', (html.match(/class="rh-open"/g) || []).length === 1 && /<a class="rh-open" href="https:\/\/g\.page\/r\/CXzIjLwvtRPdEBM\/review" target="_blank" rel="noopener noreferrer">Open review page<\/a>/.test(html));
    ok('the QR is on the card, with how to scan it', html.indexOf(qr) !== -1 && /Point your phone camera at the code\./.test(html));
    const none = H._cardHtml({ lead: {}, pick: null, qrSvg: '', url: '' });
    ok('no link set → an honest line saying where to add it, and no QR', /No Google review link is set/.test(none) && !/<svg/.test(none) && !/rh-open/.test(none));
    ok('a photo URL is escaped into the attribute', !/onerror/.test(H._cardHtml({ lead: {}, pick: { kind: 'single', after: { url: 'https://x/a.jpg" onerror="x' } }, qrSvg: '', url: '' })));
    ok('Close and Done both close it', (html.match(/data-rh-close/g) || []).length === 2);
    const css = read('docs/pro/css/review-handoff.css');
    ok('44px+ targets (close 44, buttons 52), tokens not literals, the QR on white', /\.rh-close \{[^}]*width: 44px; height: 44px;/.test(css) && /min-height: 52px/.test(css) && /background: white;/.test(css)
      && !/#[0-9a-fA-F]{3,6}\b(?![^(]*\))/.test(css.replace(/var\([^)]*\)/g, '')), css.match(/#[0-9a-fA-F]{3,6}/g));
    ok('accent text uses --ui-accent-text; no transition: all; reduced motion respected', /var\(--ui-accent-text/.test(css) && !/transition:\s*all/.test(css) && /prefers-reduced-motion: no-preference/.test(css));
    ok('full screen on a phone', /@media \(max-width: 640px\)[\s\S]*\.rh-card \{ max-width: none; min-height: 100%;/.test(css));
  }

  console.log('F. when and where');
  {
    ok('Install Done and every later stage → shown', ['install_complete', 'Final Photos', 'final_payment', 'closed', 'collections', 'deductible_collected', 'warranty_claim', 'Complete'].every((s) => H.isJobDone({ stage: s })));
    ok('earlier stages → not shown (and a deleted lead never)', ['new', 'inspected', 'contract_signed', 'install_scheduled', 'estimate_sent_cash'].every((s) => !H.isJobDone({ stage: s })) && !H.isJobDone({ stage: 'closed', deleted: true }));
    ok('a lead stamped installed counts', H.isJobDone({ stage: 'custom_x', installCompletedAt: 5 }));
    const src = read('docs/pro/js/review-handoff.js');
    ok('nothing is sent, stamped or marked asked by opening it', !/addDoc|setDoc|updateDoc|httpsCallable|reviewRequested\s*[:=]|sendReview/.test(src));
    ok('it reads the lead\'s photos with the page\'s own scoping', /W\._photoQueryScopes\(leadId\)/.test(src) && /where\('leadId', '==', leadId\), W\.where\('userId', '==', uid\)/.test(src));
    ok('one document-level listener for [data-rh-open] / [data-rh-close]; Escape closes; focus is kept in the card', /closest\('\[data-rh-open\], \[data-rh-close\]'\)/.test(src) && /ev\.key === 'Escape'/.test(src) && /ev\.key !== 'Tab'/.test(src));
    ok('a dialog: role, aria-modal, labelled by the title', /setAttribute\('role', 'dialog'\)/.test(src) && /'aria-modal', 'true'/.test(src) && /'aria-labelledby', 'rhTitle'/.test(src));
    const cust = read('docs/pro/customer.html');
    ok('customer.html: a "Job done" button (hidden until Install Done), no inline handler', /<button type="button" class="btn" id="jobDoneHandoffBtn" data-rh-open hidden title="[^"]+">\s*📱 Job done\s*<\/button>/.test(cust));
    const tags = (h) => /<link rel="stylesheet" href="css\/review-handoff\.css\?v=1">/.test(h) && /<script defer src="js\/qr-code\.js\?v=1"><\/script>\n<script defer src="js\/review-handoff\.js\?v=1"><\/script>/.test(h);
    ok('customer.html loads the CSS and both scripts with defer + ?v=, QR first', tags(cust));
    ok('the dashboard loads them only with the Field layout (needs, in order, ?v=), so its boot budget does not grow',
      /needs: \{ script: \['js\/layouts\/kit\.js', 'js\/qr-code\.js\?v=1', 'js\/review-handoff\.js\?v=1'\], css: \['css\/layouts\/kit\.css', 'css\/review-handoff\.css\?v=1'\] \}/.test(read('docs/pro/js/layout-system.js'))
      && !/review-handoff|qr-code/.test(read('docs/pro/dashboard.html')) && /layout-system\.js\?v=5/.test(read('docs/pro/dashboard.html')));
    const f = read('docs/pro/js/layouts/field.js');
    ok('Field: a Review button in the action bar for a job-done lead', /collectHtml\(it\) \+ reviewHtml\(it\) \+ '<\/div>'/.test(f) && /if \(!it \|\| !it\.id \|\| !jobDone\(leadById\(it\.id\)\)\) return '';/.test(f) && /class="lk-act fa-review" data-rh-open data-lead-id="/.test(f));
    ok('Field: the lead screen and the wrap-up offer it too', /handoffBtn\(it\.id, 'fa-big', 'Job done: show the review QR'\)/.test(f) && /wrapHandoffs\(d\)/.test(f) && /if \(!d\.done\[s\.key\] \|\| !s\.leadId \|\| seen\[s\.leadId\]\) return;/.test(f));
    ok('no inline script or on* attribute in the new files', ![src, read('docs/pro/js/qr-code.js')].some((s) => /\son[a-z]+=\s*["']/i.test(s.replace(/\/\/.*$/gm, ''))));
    ok('the QR is drawn in the page: no QR web service anywhere', !/chart\.googleapis|api\.qrserver|quickchart|goqr/i.test(src + read('docs/pro/js/qr-code.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
