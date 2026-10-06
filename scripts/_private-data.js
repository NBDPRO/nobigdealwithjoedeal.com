/**
 * scripts/_private-data.js — load a customer-data file that lives OUTSIDE the repo.
 *
 * This repo is public. A few one-off admin scripts need real customer details
 * (lead doc ids next to names, home addresses, refund amounts). Those used to
 * be hardcoded or committed as JSON; since 2026-10-06 they live in a private
 * folder on Jo's machine and the script is told where with a flag or an env var.
 *
 *   node scripts/<script>.js --data=<path-to.json>
 *   NBD_<NAME>_FILE=<path-to.json> node scripts/<script>.js
 *
 * Missing or unreadable → a clear message and exit code 2. Never a silent
 * empty list: an admin script that "found nothing to do" because its data
 * file was absent is the failure this refuses to produce.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function resolvePrivatePath({ envVar, argv = process.argv.slice(2), env = process.env }) {
  const flag = argv.find((a) => a.startsWith('--data='));
  const raw = flag ? flag.slice('--data='.length) : (env[envVar] || '');
  return raw ? path.resolve(raw) : '';
}

function loadPrivateJson({ envVar, what, argv, env, exit = (code) => process.exit(code) }) {
  const file = resolvePrivatePath({ envVar, argv, env });
  const fail = (why) => {
    console.error('\n  ' + why);
    console.error('  This script needs ' + what + ', which is customer data and is NOT in the repo.');
    console.error('  Point at the private copy with --data=<file.json> or ' + envVar + '=<file.json>.\n');
    return exit(2);
  };
  if (!file) return fail('No data file given.');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return fail('Cannot read ' + file + ' (' + e.code + ').'); }
  try { return JSON.parse(text); } catch (e) { return fail('Not valid JSON: ' + file + ' (' + e.message + ').'); }
}

module.exports = { loadPrivateJson, resolvePrivatePath };
