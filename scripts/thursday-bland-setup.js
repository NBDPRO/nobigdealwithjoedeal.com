#!/usr/bin/env node
/**
 * scripts/thursday-bland-setup.js — inspect and wire Thursday's Bland number.
 *
 * DRY-RUN by default; every write needs --apply --yes. Every command first
 * saves a full JSON backup of what it reads (number / pathway) to
 * --backup-dir (default: %TEMP%/thursday-bland-backups) BEFORE any write, so a
 * rollback is always one POST away.
 *
 *   node scripts/thursday-bland-setup.js status
 *       GET /v1/inbound/+15139405589 → backup + summary (webhook, pathway,
 *       agent, tools). Read-only.
 *
 *   node scripts/thursday-bland-setup.js set-webhook --url=<thursdayWebhook url> [--apply --yes]
 *       POSTs ONLY {"webhook": url} to /v1/inbound/+15139405589, then GETs the
 *       number again and diffs every field. Exits 1 (and prints the backup
 *       path for rollback) if ANYTHING other than the webhook changed.
 *
 *   node scripts/thursday-bland-setup.js set-first-sentence [--text="…" | --clear] [--apply --yes]
 *       POSTs ONLY {"first_sentence": …} (static opening line, spoken on
 *       connect). --clear sets it back to null. Same backup + diff guard.
 *
 *   node scripts/thursday-bland-setup.js pathway-backup [--pathway=<id>]
 *       GET the pathway (nodes/edges) → backup. Read-only.
 *
 * Env: BLAND_API_KEY (else read from Secret Manager — see scripts/_bland.js).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { bland, redact } = require('./_bland');

const NUMBER = '+15139405589';
const PATHWAY_ID = '771a3ea4-1e79-40da-aafa-6ec086688913';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'status';
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
function flag(name) {
  const a = args.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : undefined;
}
const BACKUP_DIR = flag('backup-dir') || path.join(os.tmpdir(), 'thursday-bland-backups');

function backup(label, data) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, label + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// Bland wraps some responses ({ data: {...} } / { inbound: {...} }); unwrap to the number object.
function unwrap(j) {
  if (!j || typeof j !== 'object') return j;
  if (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) return j.data;
  if (j.inbound && typeof j.inbound === 'object') return j.inbound;
  return j;
}

function summarize(n) {
  const has = (k) => n[k] != null && n[k] !== '' && !(Array.isArray(n[k]) && !n[k].length);
  return {
    phone_number: n.phone_number,
    webhook: n.webhook || null,
    pathway_id: n.pathway_id || null,
    pathway_version: n.pathway_version != null ? n.pathway_version : null,
    agent_id: n.agent_id || n.persona_id || null,
    voice: n.voice || null,
    has_prompt: has('prompt'),
    has_first_sentence: has('first_sentence'),
    tools: Array.isArray(n.tools) ? n.tools.length : (n.tools ? 1 : 0),
    transfer_phone_number: n.transfer_phone_number || null,
    max_duration: n.max_duration != null ? n.max_duration : null,
    record: n.record != null ? n.record : null,
    webhook_events: n.webhook_events || null,
  };
}

const VOLATILE = /^(updated_at|last_updated|modified_at|created_at)$/i;
function diff(a, b, prefix, out) {
  out = out || [];
  const keys = new Set([].concat(Object.keys(a || {}), Object.keys(b || {})));
  for (const k of keys) {
    if (VOLATILE.test(k)) continue;
    const p = prefix ? prefix + '.' + k : k;
    const va = a ? a[k] : undefined;
    const vb = b ? b[k] : undefined;
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va)) diff(va, vb, p, out);
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ path: p, before: va, after: vb });
  }
  return out;
}

async function getNumber() {
  return unwrap(await bland('/inbound/' + encodeURIComponent(NUMBER)));
}

async function status() {
  const n = await getNumber();
  const file = backup('inbound-' + NUMBER.replace('+', ''), n);
  console.log('Backup saved: ' + file);
  console.log(JSON.stringify(redact(summarize(n)), null, 2));
  if (n.pathway_id && n.pathway_id !== PATHWAY_ID) {
    console.log('\nNOTE: the number routes to pathway ' + n.pathway_id + ', not the expected ' + PATHWAY_ID + '.');
  }
}

async function setWebhook() {
  const url = flag('url');
  if (!url || !/^https:\/\/[a-z0-9.-]+\/.+/i.test(url)) {
    console.error('--url=https://… (the deployed thursdayWebhook URL) is required');
    process.exit(2);
  }
  if (APPLY && !YES) { console.error('Refusing to --apply without --yes. Re-run with: --apply --yes'); process.exit(2); }
  const before = await getNumber();
  const file = backup('inbound-' + NUMBER.replace('+', '') + '-before-webhook', before);
  console.log('Backup saved: ' + file);
  console.log('Current webhook : ' + (before.webhook || '(none)'));
  console.log('New webhook     : ' + url);
  console.log('Routing (kept)  : ' + JSON.stringify(redact(summarize(before))));
  if (!APPLY) { console.log('\nDry run. Would POST only {"webhook": url}. Add --apply --yes to write.'); return; }

  const resp = await bland('/inbound/' + encodeURIComponent(NUMBER), { method: 'POST', body: { webhook: url } });
  console.log('POST response:', JSON.stringify(redact(resp)).slice(0, 400));
  const after = await getNumber();
  backup('inbound-' + NUMBER.replace('+', '') + '-after-webhook', after);
  const changes = diff(before, after);
  const unexpected = changes.filter((c) => c.path !== 'webhook');
  console.log('\nChanged fields:', JSON.stringify(redact(changes.map((c) => ({ path: c.path, before: typeof c.before === 'string' ? c.before.slice(0, 80) : c.before, after: typeof c.after === 'string' ? c.after.slice(0, 80) : c.after }))), null, 2));
  if (after.webhook !== url) {
    console.error('\n✗ Webhook did not stick (reads back ' + after.webhook + ').');
    process.exit(1);
  }
  if (unexpected.length) {
    console.error('\n✗ Fields OTHER than webhook changed. Roll back by re-POSTing them from ' + file);
    process.exit(1);
  }
  console.log('\n✓ Only the webhook changed. Pathway ' + (after.pathway_id || '(none)') + ' still answers ' + NUMBER + '.');
}

// Dead air (THURSDAY-BLAND §10): the compiled start node waits for the
// caller's voice, so a silent caller hears nothing. A static first_sentence
// on the number is spoken on connect. --clear restores null (rollback).
const DEFAULT_FIRST_SENTENCE = "Thanks for calling No Big Deal Home Solutions, this is Thursday, Joe's assistant. " +
  'Just so you know, calls are recorded so Joe gets your message right. How can I help?';
// Representation-only drift already seen on a webhook POST (§7): empty before and after.
const EMPTY_DRIFT = /^(custom_tools|tools)$/;

async function setFirstSentence() {
  const clear = args.includes('--clear');
  const text = clear ? null : (flag('text') || DEFAULT_FIRST_SENTENCE);
  if (APPLY && !YES) { console.error('Refusing to --apply without --yes. Re-run with: --apply --yes'); process.exit(2); }
  const before = await getNumber();
  const file = backup('inbound-' + NUMBER.replace('+', '') + '-before-first-sentence', before);
  console.log('Backup saved: ' + file);
  console.log('Current first_sentence : ' + JSON.stringify(before.first_sentence));
  console.log('New first_sentence     : ' + JSON.stringify(text));
  if (!APPLY) { console.log('\nDry run. Would POST only {"first_sentence": …}. Add --apply --yes to write.'); return; }

  const resp = await bland('/inbound/' + encodeURIComponent(NUMBER), { method: 'POST', body: { first_sentence: text } });
  console.log('POST response:', JSON.stringify(redact(resp)).slice(0, 400));
  const after = await getNumber();
  backup('inbound-' + NUMBER.replace('+', '') + '-after-first-sentence', after);
  const changes = diff(before, after);
  const emptyish = (v) => v == null || v === '[]' || (Array.isArray(v) && !v.length);
  const unexpected = changes.filter((c) => c.path !== 'first_sentence' &&
    !(EMPTY_DRIFT.test(c.path) && emptyish(c.before) && emptyish(c.after)));
  console.log('\nChanged fields:', JSON.stringify(changes.map((c) => c.path)));
  if ((after.first_sentence || null) !== text) {
    console.error('\n✗ first_sentence did not stick (reads back ' + JSON.stringify(after.first_sentence) + ').');
    process.exit(1);
  }
  if (unexpected.length) {
    console.error('\n✗ Fields OTHER than first_sentence changed. Roll back by re-POSTing them from ' + file);
    process.exit(1);
  }
  // GET /v1/inbound omits persona_id; confirm ownership via GET /v1/personas/{id}.
  console.log('\n✓ Only first_sentence changed on ' + NUMBER + '.');
}

async function pathwayBackup() {
  const id = flag('pathway') || PATHWAY_ID;
  const p = await bland('/pathway/' + encodeURIComponent(id));
  const file = backup('pathway-' + id, p);
  const body = unwrap(p) || {};
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  console.log('Backup saved: ' + file);
  console.log(JSON.stringify({
    name: body.name, nodes: nodes.length, edges: Array.isArray(body.edges) ? body.edges.length : 0,
    startNode: (nodes.find((n) => n && n.data && n.data.isStart) || {}).id || null,
    nodeTypes: nodes.reduce((m, n) => { const t = (n && n.type) || '?'; m[t] = (m[t] || 0) + 1; return m; }, {}),
  }, null, 2));
}

const COMMANDS = { status, 'set-webhook': setWebhook, 'set-first-sentence': setFirstSentence, 'pathway-backup': pathwayBackup };
if (!COMMANDS[cmd]) { console.error('Unknown command ' + cmd + '. Use: ' + Object.keys(COMMANDS).join(' | ')); process.exit(2); }
COMMANDS[cmd]().catch((e) => { console.error(e && e.message || e); process.exit(1); });
