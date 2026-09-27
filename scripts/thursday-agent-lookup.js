#!/usr/bin/env node
/**
 * scripts/thursday-agent-lookup.js — give Thursday (Bland v2 agent
 * "Thursday - NBD Reception", 4c2b2b93-…) the live caller lookup so she
 * greets a known caller by first name.
 *
 * WHY THE AGENT, NOT THE PATHWAY: pathway 771a3ea4 is COMPILED from this
 * agent (description "v2-agent:4c2b2b93…"); a hand-edited pathway node is
 * wiped the next time Jo saves the agent in Bland. The agent's own
 * Initialization step runs at call start, before she speaks, and whatever
 * JSON it returns becomes variables the prompt can use.
 *
 * What the new version changes, relative to the version it is built on:
 *   1. snapshot.initialization: enabled, code = POST the caller's number to
 *      thursdayCallerLookup (Bearer {{env THURSDAY_LOOKUP_TOKEN}}, 2.5 s
 *      timeout, any failure → "unknown caller" so the greeting never waits);
 *      returns caller_known / caller_first_name / caller_job_hint.
 *   2. One RETURNING CALLERS block appended to the agent node's prompt —
 *      "Is this {{caller_first_name}}?" and use the name only after a yes;
 *      never reveal whose number it is — plus a one-line RECORDING NOTICE
 *      (Jo's decision 2026-09-26: say calls are recorded, even though OH/KY
 *      are one-party-consent states).
 * Nothing else in the snapshot is touched (the script diffs to prove it).
 *
 *   node scripts/thursday-agent-lookup.js                 # dry-run: base version, diff, new prompt block
 *   node scripts/thursday-agent-lookup.js --publish --yes # new version → STAGING only
 *   node scripts/thursday-agent-lookup.js --promote --yes # staging → PRODUCTION (after Jo's test + OK)
 *   node scripts/thursday-agent-lookup.js --rollback=0.3.0 --yes   # re-publish an old version + promote
 *
 * Every run first backs up the base version JSON to %TEMP%/thursday-bland-backups.
 * Env: BLAND_API_KEY (else Secret Manager — scripts/_bland.js).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { secret } = require('./_bland');

const AGENT = '4c2b2b93-9251-4477-b9b3-3dbfae4eccfe';
const LOOKUP_URL = 'https://us-central1-nobigdeal-pro.cloudfunctions.net/thursdayCallerLookup';
const MARK = 'RETURNING CALLERS (caller lookup)';
const args = process.argv.slice(2);
const YES = args.includes('--yes');
const PUBLISH = args.includes('--publish');
const PROMOTE = args.includes('--promote');
const ROLLBACK = (args.find((a) => a.startsWith('--rollback=')) || '').slice(11);
const BACKUP_DIR = path.join(os.tmpdir(), 'thursday-bland-backups');

async function v2(p, opts) {
  const o = opts || {};
  const r = await fetch('https://api.bland.ai/v2' + p, {
    method: o.method || 'GET',
    headers: Object.assign({ authorization: secret('BLAND_API_KEY') }, o.body ? { 'content-type': 'application/json' } : {}),
    body: o.body ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!r.ok) throw new Error((o.method || 'GET') + ' ' + p + ' → ' + r.status + ' ' + text.slice(0, 300));
  return json;
}

// The Initialization step (Bland runs it as a fetch handler at call start).
// Returns strings only — prompt variables are text.
const INIT_CODE = `export default {
  async fetch(request, env, ctx) {
    const json = await request.json().catch(() => ({}));
    const from = json.from || json.phone_number || json.caller || json.short_from || '';
    const unknown = { caller_known: 'false', caller_first_name: '', caller_job_hint: '' };
    const token = env && (env.THURSDAY_LOOKUP_TOKEN || (env.vars && env.vars.THURSDAY_LOOKUP_TOKEN));
    if (!from || !token) return Response.json(unknown);
    try {
      const r = await fetch('${LOOKUP_URL}', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ from: String(from) }),
        signal: AbortSignal.timeout(2500),
      });
      if (!r.ok) return Response.json(unknown);
      const d = await r.json();
      if (!d || d.known !== true || !d.first_name) return Response.json(unknown);
      return Response.json({ caller_known: 'true', caller_first_name: String(d.first_name), caller_job_hint: String(d.job_hint || '') });
    } catch (e) {
      return Response.json(unknown);
    }
  }
}`;

const PROMPT_BLOCK = `

${MARK}
Before you speak, the phone system may recognize the caller's number from Joe's customer list.
If {{caller_known}} is "true": open with "Thanks for calling No Big Deal Home Solutions, this is Thursday, Joe's assistant. Is this {{caller_first_name}}?"
- If they say yes, use their first name naturally for the rest of the call. If it fits, you can ask "Is this about {{caller_job_hint}}?" — only if that phrase is not empty.
- If they say no, or someone else is calling from that phone, apologize lightly ("Oh sorry about that!"), never use that name again, and carry on with the normal call. Never say whose number it is, and never mention any address, job, price or claim because of the lookup.
- Still get the name, callback number and address as usual; the lookup is only a friendly greeting, not proof of who they are.
If {{caller_known}} is anything else (false, empty, or literally "{{caller_known}}"), use the normal OPENING above.

RECORDING NOTICE
On every call, once, right after your opening line and before you ask how you can help, say: "Just so you know, calls are recorded so Joe gets your message right." Keep it light and move on. (Jo's decision, 2026-09-26.)`;

function backup(label, data) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const f = path.join(BACKUP_DIR, label + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
  return f;
}

async function productionVersion() {
  const agent = await v2('/agents/' + AGENT);
  const envs = (agent.data || agent).environments || [];
  const prod = envs.find((e) => e.env_type === 'production');
  const staging = envs.find((e) => e.env_type === 'staging');
  const list = await v2('/agents/' + AGENT + '/versions');
  const versions = list.data || list;
  const byId = (id) => versions.find((v) => v.id === id) || {};
  return { prod: byId(prod && prod.current_version_id), staging: byId(staging && staging.current_version_id), versions };
}

function buildSnapshot(base) {
  const snap = JSON.parse(JSON.stringify(base.snapshot));
  const agentNode = (snap.behavior.nodes || []).find((n) => n.type === 'agent');
  if (!agentNode) throw new Error('no agent node in snapshot');
  const prompt = agentNode.data.prompt || '';
  if (prompt.indexOf(MARK) !== -1) throw new Error('base version already has the ' + MARK + ' block');
  agentNode.data.prompt = prompt + PROMPT_BLOCK;
  snap.initialization = snap.initialization || {};
  snap.initialization.enabled = true;
  snap.initialization.step = Object.assign({}, snap.initialization.step || {}, { name: 'Caller lookup', code: INIT_CODE });
  return snap;
}

function diffPaths(a, b, pre, out) {
  out = out || [];
  const keys = new Set([].concat(Object.keys(a || {}), Object.keys(b || {})));
  for (const k of keys) {
    const p = pre ? pre + '.' + k : k;
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    if (va && vb && typeof va === 'object' && typeof vb === 'object') diffPaths(va, vb, p, out);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(p);
  }
  return out;
}

async function main() {
  if ((PUBLISH || PROMOTE || ROLLBACK) && !YES) { console.error('Refusing to write without --yes.'); process.exit(2); }
  const { prod, staging } = await productionVersion();
  console.log('production: ' + prod.semver + ' (' + prod.id + ')   staging: ' + staging.semver + ' (' + staging.id + ')');

  if (PROMOTE) {
    const r = await v2('/agents/' + AGENT + '/promote', { method: 'POST', body: {} });
    console.log('promoted staging → production:', JSON.stringify((r.data && r.data.environments) || r).slice(0, 400));
    return;
  }
  if (ROLLBACK) {
    const full = await v2('/agents/' + AGENT + '/versions/' + ROLLBACK);
    const v = full.data || full;
    backup('agent-rollback-source-' + ROLLBACK, v);
    const pub = await v2('/agents/' + AGENT + '/publish', { method: 'POST', body: { version_id: v.id } });
    console.log('re-published ' + ROLLBACK + ' to staging:', (pub.data && pub.data.semver) || '');
    const pro = await v2('/agents/' + AGENT + '/promote', { method: 'POST', body: {} });
    console.log('promoted:', JSON.stringify((pro.data && pro.data.environments) || pro).slice(0, 300));
    return;
  }

  const base = (await v2('/agents/' + AGENT + '/versions/' + prod.semver)).data;
  const f = backup('agent-base-' + prod.semver, base);
  console.log('base backup: ' + f);
  const snap = buildSnapshot(base);
  const changed = diffPaths(base.snapshot, snap, '');
  console.log('changed snapshot paths: ' + JSON.stringify(changed));
  const allowed = /^(behavior\.nodes\.\d+\.data\.prompt|initialization\.enabled|initialization\.step\.(code|name))$/;
  const stray = changed.filter((p) => !allowed.test(p));
  if (stray.length) { console.error('✗ unexpected changes: ' + stray.join(', ')); process.exit(1); }
  console.log('\n── prompt block appended ──' + PROMPT_BLOCK + '\n── init code ──\n' + INIT_CODE);

  if (!PUBLISH) { console.log('\nDry run. --publish --yes puts this on STAGING only (production stays ' + prod.semver + ').'); return; }
  const pub = await v2('/agents/' + AGENT + '/publish', { method: 'POST', body: { snapshot: snap, bump: 'minor' } });
  const d = pub.data || pub;
  backup('agent-published-' + (d.semver || 'new'), d);
  console.log('\n✓ published to STAGING as ' + d.semver + '. Production is unchanged (' + prod.semver + ').');
  console.log('  environments: ' + JSON.stringify(d.environments || []).slice(0, 400));
}

main().catch((e) => { console.error(e && e.message || e); process.exit(1); });
