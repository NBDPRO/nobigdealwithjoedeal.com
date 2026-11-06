#!/usr/bin/env node
/**
 * scripts/audit/emulators.js — start the CRM audit harness emulators
 * (auth, firestore, storage, hosting — NEVER functions: the functions emulator
 * can read real Twilio/Resend secrets and has sent real texts before).
 *
 * Why not plain `firebase emulators:start`: on Jo's machine port 8080 (the
 * Firestore emulator's port in firebase.json) is held by another local app.
 * This writes a throwaway copy of firebase.json with ONLY the Firestore port
 * moved (default 8085, override with NBD_AUDIT_FS_PORT), starts the emulators
 * from it, and deletes the copy on exit. firebase.json itself is untouched.
 * The browser side follows via scripts/audit/harness.js, whose Playwright init
 * script rewrites the client's hard-coded 127.0.0.1:8080 to the moved port.
 *
 * Usage (repo root):  node scripts/audit/emulators.js
 *   then, in another shell:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *     node scripts/audit/seed-audit-tenants.js --reset
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FS_PORT = Number(process.env.NBD_AUDIT_FS_PORT || 8085);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
if (!cfg.emulators || !cfg.emulators.firestore) throw new Error('firebase.json has no emulators.firestore block');
cfg.emulators.firestore.port = FS_PORT;
const tmp = path.join(ROOT, 'firebase.audit-local.json'); // must sit in ROOT: relative paths resolve from it
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
const cleanup = () => { try { fs.unlinkSync(tmp); } catch (_) { /* gone */ } };

const bin = path.join(ROOT, 'tests', 'node_modules', '.bin', process.platform === 'win32' ? 'firebase.cmd' : 'firebase');
const env = Object.assign({}, process.env);
['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].forEach((k) => delete env[k]);
env.JAVA_TOOL_OPTIONS = env.JAVA_TOOL_OPTIONS || '-Xmx4g';
const child = spawn(bin, ['emulators:start', '--only', 'auth,firestore,storage,hosting',
  '--project', 'nobigdeal-pro', '--config', tmp], { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => { cleanup(); process.exit(code == null ? 1 : code); });
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { child.kill(s); }));
process.on('exit', cleanup);
