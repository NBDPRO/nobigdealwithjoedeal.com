/**
 * scripts/_bland.js — shared helpers for the Thursday (Bland AI) admin scripts.
 *
 * Secrets never come through the command line or chat. Each value is read, in
 * order, from:
 *   1. the environment (BLAND_API_KEY / ANTHROPIC_API_KEY …), or
 *   2. Google Secret Manager — the same secret the Cloud Functions bind —
 *      via `gcloud secrets versions access latest` under your gcloud login.
 * The value is held in memory only; nothing here prints or writes it.
 */
'use strict';

const { execFileSync } = require('child_process');

const BLAND_API = 'https://api.bland.ai/v1';
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

const _cache = {};
function secret(name) {
  if (_cache[name]) return _cache[name];
  let v = (process.env[name] || '').trim();
  if (!v) {
    try {
      v = execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=' + name, '--project=' + PROJECT],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }).trim();
    } catch (e) {
      v = '';
    }
  }
  if (!v || v === '__unset__') {
    throw new Error(name + ' is not available. Set it with `firebase functions:secrets:set ' + name +
      ' --project ' + PROJECT + '` (or export it for this shell).');
  }
  _cache[name] = v;
  return v;
}

async function bland(path, opts) {
  const o = opts || {};
  const r = await fetch(BLAND_API + path, {
    method: o.method || 'GET',
    headers: Object.assign({ authorization: secret('BLAND_API_KEY') }, o.body ? { 'content-type': 'application/json' } : {}),
    body: o.body ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(o.timeoutMs || 30000),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!r.ok) {
    const err = new Error('Bland ' + (o.method || 'GET') + ' ' + path + ' → ' + r.status + ' ' + text.slice(0, 300));
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Mask anything that looks like a credential before a JSON blob is printed.
function redact(obj) {
  return JSON.parse(JSON.stringify(obj == null ? null : obj, (k, v) => {
    if (typeof v === 'string' && /key|secret|token|authorization|password/i.test(k) && v.length > 6) {
      return v.slice(0, 3) + '…(' + v.length + ' chars)';
    }
    return v;
  }));
}

module.exports = { BLAND_API, PROJECT, secret, bland, redact };
