/**
 * tests/esign-setup-void-2026-09-16.test.js — "Void this link" button, driven for real.
 *
 * functions/esign-envelope.js's voidEsignEnvelope callable has existed since
 * it was built, fully implemented (revokes live esign_tokens, flips the
 * envelope to status:'voided'), but nothing in the rep-facing UI ever called
 * it — the only way to invalidate a live link was to re-send (which mints a
 * NEW link too, not a bare cancel). This pins the new docs/pro/esign-setup.js
 * wiring: a "Void this link" button that appears only while a live link
 * could exist (status 'sent' or 'viewed'), calls voidEsignEnvelope with the
 * open envelope's id, and disappears once voided.
 *
 * Follows the house pattern in tests/esign-setup-placement.test.js: real
 * Chromium via Playwright, the gstatic Firebase SDK modules replaced with
 * local stubs (no auth/network/App Check/emulator involved), envelope state
 * driven entirely from the page's own httpsCallable stub so every status
 * transition (sent → voided, draft, completed) is exercised without a
 * backend of any kind.
 *
 * Run from tests/: node esign-setup-void-2026-09-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const { PDFDocument } = require(path.join(FN, 'node_modules', 'pdf-lib'));

function serve(dir) {
  const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
  const s = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

async function buildPdfBase64() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save()).toString('base64');
}

/* Same shape as tests/esign-setup-placement.test.js's STUBS, with
 * getEsignEnvelopeForOwner/voidEsignEnvelope filled in against a
 * page-global __testEnv the test sets per case via addInitScript. */
function stubs(pdfBase64) {
  return {
    'firebase-app.js': `export function initializeApp(){return {name:'stub'}} export function getApps(){return []}`,
    'firebase-app-check.js': `export function initializeAppCheck(){return {}} export class ReCaptchaEnterpriseProvider{}`,
    'firebase-auth.js': `export function getAuth(){return {}}
      export function onAuthStateChanged(a,cb){ setTimeout(()=>cb({uid:'REPUID'}),0); }`,
    'firebase-storage.js': `export function getStorage(){return {}}
      export function ref(){return {}}
      export async function uploadBytes(){ return {}; }`,
    'firebase-functions.js': `export function getFunctions(){return {}}
      export function httpsCallable(_f,name){
        return async (payload)=>{
          (globalThis.__calls=globalThis.__calls||[]).push({name,payload});
          if (name==='getEsignEnvelopeForOwner') {
            const st = (globalThis.__testEnv && globalThis.__testEnv.status) || 'sent';
            return {data:{
              envelopeId: payload.envelopeId, title: 'Void Button Test Doc', leadId: 'LEAD1',
              status: st, pages: [{width:200,height:200,rotation:0}],
              fields: [{id:'f1',type:'signature',page:1,x:10,y:10,w:30,h:10,required:true,role:'signer'}],
              signerName: 'Test Signer', signerEmail: 'signer@example.com',
              pdf: ${JSON.stringify(pdfBase64)},
            }};
          }
          if (name==='voidEsignEnvelope') {
            if (globalThis.__testEnv) globalThis.__testEnv.status = 'voided';
            return {data:{ok:true, revoked:1}};
          }
          return {data:{ok:true}};
        };
      }`,
    'nbd-emulator-connect.js': `export async function connectEmulatorsIfLocal(){return false}
      export async function emulatorAppCheckIfLocal(){return false}
      export function isLocalEmulatorEnv(){return false}`,
  };
}

(async () => {
  console.log('\nesign-setup Void button — appears only for a live link, calls voidEsignEnvelope\n');

  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) { console.log('  ! playwright unavailable — SKIPPED'); return report(); }

  console.log('SOURCE CONTRACT — the real file actually has this wiring');
  {
    const src = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'esign-setup.js'), 'utf8');
    ok('el.void maps to #suVoid', /void:\s*\$\('suVoid'\)/.test(src));
    ok('a click on the void button calls voidEsignEnvelope with envelopeId',
      /el\.void\.addEventListener\('click'/.test(src)
      && /httpsCallable\(fns, 'voidEsignEnvelope'\)\(\{\s*envelopeId\s*\}\)/.test(src));
    ok('the void confirm is routed through the guarded nbdConfirm fallback (tests/pwa-confirm-guard.test.js)',
      /const ask = window\.nbdConfirm \|\| \(\(m\) => Promise\.resolve\(window\.confirm\(m\)\)\);[\s\S]{0,120}await ask\(/.test(
        src.slice(src.indexOf("el.void.addEventListener('click'")))
      );
    const html = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'esign-setup.html'), 'utf8');
    ok('the button starts hidden in markup', /id="suVoid"[^>]*hidden/.test(html));
  }

  const pdfBase64 = await buildPdfBase64();
  const server = await serve(path.join(ROOT, 'docs'));
  const port = server.address().port;
  const browser = await chromium.launch();
  const errs = [];

  async function openWithStatus(status, expectVoidHidden) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.addInitScript((st) => { window.__testEnv = { status: st }; }, status);
    for (const [file, body] of Object.entries(stubs(pdfBase64))) {
      await page.route(`**/${file}`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
    }
    await page.goto(`http://127.0.0.1:${port}/pro/esign-setup.html?env=ENV1`);
    await page.waitForSelector('.es-page canvas', { timeout: 20000 });
    // renderAll() appends the canvas BEFORE awaiting page.render(...).promise
    // (esign-setup.js:136-152), and updateVoidVisibility() only runs after
    // that promise resolves and openBytes() returns. The selector above can
    // match mid-render, before the button's hidden state is actually set —
    // an intermittent race, not a timing coincidence (flaked in CI on PRs
    // that never touched this file). Wait for the settled state itself,
    // same as every su-field wait in esign-setup-placement.test.js.
    await page.waitForFunction(
      (want) => document.getElementById('suVoid').hidden === want,
      expectVoidHidden, { timeout: 8000 },
    );
    return page;
  }

  try {
    console.log('\nLIVE LINK — status "sent" shows the Void button');
    {
      const page = await openWithStatus('sent', false);
      const hidden = await page.locator('#suVoid').isHidden();
      ok('Void button is visible', !hidden);

      await page.click('#suVoid');
      await page.waitForFunction(
        '(globalThis.__calls || []).some(c => c.name === "voidEsignEnvelope")', null, { timeout: 8000 });
      const call = await page.evaluate(() => globalThis.__calls.find((c) => c.name === 'voidEsignEnvelope'));
      ok('clicking it calls voidEsignEnvelope with this envelope\'s id', call && call.payload.envelopeId === 'ENV1',
        JSON.stringify(call));

      await page.waitForFunction('document.getElementById("suVoid").hidden === true', null, { timeout: 8000 });
      ok('the button hides itself again once voided', true);
      const statusText = await page.locator('#suStatus').textContent();
      ok('the status line confirms the void', /voided/i.test(statusText || ''), statusText);
      await page.close();
    }

    console.log('\nVIEWED LINK — status "viewed" also shows the Void button');
    {
      const page = await openWithStatus('viewed', false);
      ok('Void button is visible', !(await page.locator('#suVoid').isHidden()));
      await page.close();
    }

    console.log('\nDRAFT — no link has ever been sent, nothing to void');
    {
      const page = await openWithStatus('draft', true);
      ok('Void button stays hidden', await page.locator('#suVoid').isHidden());
      await page.close();
    }

    console.log('\nCOMPLETED — already signed, voiding is meaningless (and the backend itself refuses it)');
    {
      const page = await openWithStatus('completed', true);
      ok('Void button stays hidden', await page.locator('#suVoid').isHidden());
      await page.close();
    }

    ok('no JS errors across the whole session', errs.length === 0, errs.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  report();
})().catch((e) => { console.error('\nFATAL', (e && e.stack) || e); process.exit(1); });

function report() {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
  process.exit(0);
}
