#!/usr/bin/env node
/**
 * scripts/check-public-invoker.mjs — READ-ONLY weekly check that every
 * browser-facing Cloud Function (onRequest / onCall) still grants
 * allUsers → roles/run.invoker on its Cloud Run service. Rules + why:
 * scripts/public-invoker-logic.js.
 *
 *   node scripts/check-public-invoker.mjs
 *
 * Credentials: Application Default Credentials (CI writes the
 * FIREBASE_SERVICE_ACCOUNT JSON and sets GOOGLE_APPLICATION_CREDENTIALS);
 * locally, falls back to `gcloud auth print-access-token`. Only GETs:
 * services.list and services.getIamPolicy. It never changes a policy; the
 * fix for each finding is printed for a human to run.
 *
 * Exit 0 all public · 1 a function is not public · 2 couldn't check (an API
 * error is reported as an error, never as "not public").
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = require('./public-invoker-logic.js');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const REGION = 'us-central1';
const API = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services`;
const summary = process.env.GITHUB_STEP_SUMMARY;
const say = (line) => { console.log(line); if (summary) fs.appendFileSync(summary, line + '\n'); };

// 1. Which functions are browser-facing: load the real functions/index.js.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || PROJECT;
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: PROJECT, storageBucket: PROJECT + '.appspot.com' });
const log = console.log, info = console.info;
console.log = () => {}; console.info = () => {};
let fnExports;
try { fnExports = require(path.join(ROOT, 'functions', 'index.js')); }
finally { console.log = log; console.info = info; }
const functions = L.browserFacing(fnExports);

// 2. A token: ADC first, then the gcloud CLI.
async function token() {
  try {
    const { GoogleAuth } = require(path.join(ROOT, 'functions', 'node_modules', 'google-auth-library'));
    const client = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    const t = await client.getAccessToken();
    if (t && (t.token || typeof t === 'string')) return t.token || t;
  } catch (e) { /* fall through to gcloud */ }
  return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
}

async function getJson(url, tok) {
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + tok }, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 160));
  return JSON.parse(text);
}

(async () => {
  let tok;
  try { tok = await token(); } catch (e) { say('### Public-invoker watch: could not get credentials\n\n' + e.message); process.exit(2); }

  // 3. Which services exist (a function not deployed yet is not an error).
  const existing = new Set();
  let pageToken = '';
  try {
    do {
      const page = await getJson(API + '?pageSize=500' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), tok);
      for (const s of page.services || []) existing.add(s.name.split('/').pop());
      pageToken = page.nextPageToken || '';
    } while (pageToken);
  } catch (e) { say('### Public-invoker watch: could not list Cloud Run services\n\n' + e.message); process.exit(2); }

  // 4. Each browser-facing function's policy, 10 at a time.
  const results = {};
  for (let i = 0; i < functions.length; i += 10) {
    await Promise.all(functions.slice(i, i + 10).map(async (f) => {
      if (!existing.has(f.service)) { results[f.service] = { missingService: true }; return; }
      try { results[f.service] = { policy: await getJson(API + '/' + f.service + ':getIamPolicy', tok) }; }
      catch (e) { results[f.service] = { error: e.message }; }
    }));
  }

  const v = L.judge(functions, results);
  say(`### Public-invoker watch: ${v.ok ? 'all public' : 'ACTION NEEDED'}`);
  say('');
  say(`${v.checked} browser-facing functions checked; ${v.checked - v.notPublic.length - v.errors.length - v.missingService.length} public, ${v.notPublic.length} not public, ${v.errors.length} errors, ${v.missingService.length} not deployed.`);
  for (const f of v.notPublic) { say(''); say(`- **${f.name}** (${f.kind}) has no allUsers run.invoker: every browser request is a 403 before the handler runs.`); say(`  Fix: ${L.fixFor(f, { project: PROJECT, region: REGION })}`); }
  for (const f of v.errors) say(`- ${f.name}: could not read its policy (${f.error})`);
  if (v.missingService.length) say(`- not deployed yet: ${v.missingService.map((f) => f.name).join(', ')}`);
  process.exit(v.notPublic.length ? 1 : v.errors.length ? 2 : 0);
})();
