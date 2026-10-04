/**
 * tests/followup-notif-flood-2026-10-03.test.js — at most ONE follow_up
 * notification per (lead, local day), across reloads AND across tabs.
 *
 * The owner tenant had 18,169 follow_up docs (17,562 unread) across 89 leads,
 * up to 31 for one lead in one day. crm-snooze.js wrote with addDoc (random
 * id) and deduped against window._notifications — the bell feed, the newest
 * 50 docs of any type. With more leads due than fit in that window, every
 * engine run re-created the ones that had scrolled out; two tabs each wrote
 * their own copy.
 *
 * Drives the REAL engine (crm-snooze.js) in vm contexts against one shared
 * fake Firestore that applies the production rule for notifications: the
 * identity fields (userId/type/leadId/dateKey/createdAt) are immutable, so a
 * setDoc onto an existing id is refused (permission-denied) — create-only.
 * The fake feed (onSnapshot) is the real query's shape: newest 50.
 *
 * The only source rewrite is the CDN dynamic import → the fake module (a vm
 * script cannot import a URL).
 *
 * Zero deps.  Run: node tests/followup-notif-flood-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/crm-snooze.js'), 'utf8');
const CDN = 'import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")';
const PATCHED = SRC.split(CDN).join('__fsImport()');

// ── one shared fake Firestore (the server) ───────────────────────────────
function makeServer() {
  const docs = new Map(); let seq = 0; let clock = Date.now();
  const IMMUTABLE = ['userId', 'type', 'leadId', 'dateKey', 'createdAt'];
  const TS = { __ts: true };
  const materialize = (data) => {
    const o = {};
    Object.keys(data).forEach((k) => { o[k] = data[k] === TS ? { ms: ++clock, toMillis() { return this.ms; } } : data[k]; });
    return o;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const listeners = [];
  const feed = (uid) => Array.from(docs.entries())
    .filter(([, d]) => d.userId === uid)
    .sort((a, b) => b[1].createdAt.ms - a[1].createdAt.ms)
    .slice(0, 50)
    .map(([id, d]) => ({ id, data: () => Object.assign({}, d) }));
  const notify = () => listeners.forEach((l) => l.cb({ docs: feed(l.uid) }));
  function mod() {
    return {
      collection: (db, name) => ({ name }),
      doc: (db, name, id) => ({ name, id }),
      where: (f, op, v) => ({ f, v }),
      orderBy: () => ({}), limit: () => ({}),
      query: (c, ...cs) => ({ c, cs }),
      serverTimestamp: () => TS,
      async addDoc(c, data) { const id = 'auto' + (++seq); docs.set(id, materialize(data)); notify(); return { id }; },
      async setDoc(ref, data) {
        const prev = docs.get(ref.id);
        const next = materialize(data);
        if (prev) {
          const changed = IMMUTABLE.some((k) => !same(prev[k], next[k]));
          if (changed) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
        }
        docs.set(ref.id, next); notify();
      },
      async updateDoc(ref, patch) { docs.set(ref.id, Object.assign({}, docs.get(ref.id), patch)); notify(); },
      async getDocs(q) {
        const eq = (q.cs || []).filter((x) => x && x.f);
        const rows = Array.from(docs.entries()).filter(([, d]) => eq.every((w) => d[w.f] === w.v))
          .map(([id, d]) => ({ id, data: () => Object.assign({}, d) }));
        return { docs: rows, size: rows.length, forEach: (fn) => rows.forEach(fn) };
      },
      onSnapshot(q, cb) {
        const uid = (q.cs.find((x) => x && x.f === 'userId') || {}).v;
        const l = { uid, cb }; listeners.push(l); cb({ docs: feed(uid) });
        return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
      },
    };
  }
  return { docs, mod };
}

// ── one browser tab running the real crm-snooze.js ───────────────────────
function makeTab(server, uid) {
  const M = server.mod();
  const win = {
    _user: { uid }, _auth: { currentUser: { uid } }, _db: {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    nbdFollowUpDay(v) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v)); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v); },
    stageRole(k) { return /^(closed|install_complete)$/.test(k) ? 'won' : /^lost$/.test(k) ? 'lost' : 'active'; },
  };
  win.window = win;
  const sandbox = {
    window: win, document: { addEventListener() {}, body: {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    __fsImport: () => Promise.resolve(M),
    Date, Math, JSON, Object, Array, String, Number, Set, Map, Promise, Error, Event: function () {},
  };
  vm.runInNewContext(PATCHED, sandbox, { filename: 'crm-snooze.js' });
  return win;
}

function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const today = new Date(); today.setHours(0, 0, 0, 0);
const past = new Date(today); past.setDate(past.getDate() - 5);
const LEADS = Array.from({ length: 89 }, (_, i) => ({ id: 'lead' + i, firstName: 'Cust', lastName: String(i), stage: 'contacted', followUp: ymd(past) }));
const followUps = (server) => Array.from(server.docs.values()).filter((d) => d.type === 'follow_up');
const perLeadDay = (server) => {
  const m = {}; followUps(server).forEach((d) => { const k = d.leadId + '|' + d.dateKey; m[k] = (m[k] || 0) + 1; }); return m;
};
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('FOLLOW-UP NOTIFICATIONS — one per (lead, day)');

  // 1. One tab, 89 overdue leads, the engine runs on every loadLeads.
  {
    const server = makeServer();
    const tab = makeTab(server, 'jo');
    await flush();
    for (let i = 0; i < 4; i++) { await tab.checkAndCreateFollowUpNotifications(LEADS); await flush(); }
    const n = followUps(server).length;
    ok('four engine runs over 89 due leads leave exactly 89 docs', n === 89, n + ' docs');
    ok('no lead-day has a duplicate', Object.values(perLeadDay(server)).every((c) => c === 1));
    const anyDoc = followUps(server)[0] || {};
    ok('dateKey is the LOCAL date', anyDoc.dateKey === ymd(today), anyDoc.dateKey);
    const ids = Array.from(server.docs.keys());
    ok('doc id is deterministic: follow_up_<uid>_<lead>_<day>', ids.includes('follow_up_jo_lead0_' + ymd(today)), ids.slice(0, 2).join(','));
  }

  // 2. A reload (fresh tab, empty memory) on the same day writes nothing new.
  {
    const server = makeServer();
    await makeTab(server, 'jo').checkAndCreateFollowUpNotifications(LEADS);
    const reloaded = makeTab(server, 'jo');
    await reloaded.checkAndCreateFollowUpNotifications(LEADS);
    ok('a reload on the same day adds no docs', followUps(server).length === 89, followUps(server).length + ' docs');
  }

  // 3. Two writers (two tabs / devices) racing on the same day → ONE doc each.
  {
    const server = makeServer();
    const a = makeTab(server, 'jo'), b = makeTab(server, 'jo');
    await Promise.all([a.checkAndCreateFollowUpNotifications(LEADS.slice(0, 1)), b.checkAndCreateFollowUpNotifications(LEADS.slice(0, 1))]);
    ok('two writers, same lead, same day → 1 doc', followUps(server).length === 1, followUps(server).length + ' docs');
    await Promise.all([a.checkAndCreateFollowUpNotifications(LEADS), b.checkAndCreateFollowUpNotifications(LEADS)]);
    ok('two writers over 89 leads → 89 docs, not 178', followUps(server).length === 89, followUps(server).length + ' docs');
  }

  // 4. The race loser can't reset what the rep already did.
  {
    const server = makeServer();
    await makeTab(server, 'jo').checkAndCreateFollowUpNotifications(LEADS.slice(0, 1));
    const id = Array.from(server.docs.keys())[0];
    server.docs.get(id).read = true;
    // A second device whose day-read missed it (e.g. it raced) still can't overwrite.
    const m = server.mod();
    let refused = false;
    try { await m.setDoc({ id }, { userId: 'jo', type: 'follow_up', leadId: 'lead0', dateKey: ymd(today), read: false, createdAt: m.serverTimestamp() }); }
    catch (e) { refused = e.code === 'permission-denied'; }
    ok('re-creating an existing id is refused (create-only rule shape)', refused);
    await makeTab(server, 'jo').checkAndCreateFollowUpNotifications(LEADS.slice(0, 1));
    ok('a read notification stays read', server.docs.get(id).read === true);
  }

  // 5. Closed / lost leads never generate a follow-up notice.
  {
    const server = makeServer();
    const t = makeTab(server, 'jo');
    await t.checkAndCreateFollowUpNotifications([
      { id: 'w', stage: 'closed', followUp: ymd(past) },
      { id: 'l', stage: 'lost', followUp: ymd(past) },
      { id: 'd', stage: 'contacted', deleted: true, followUp: ymd(past) },
      { id: 'o', stage: 'contacted', followUp: ymd(past) },
    ]);
    const leadIds = followUps(server).map((d) => d.leadId);
    ok('lowercase lost/closed keys and deleted leads are skipped; the open one notifies',
      leadIds.length === 1 && leadIds[0] === 'o', JSON.stringify(leadIds));
  }

  // 6. A legacy random-id doc for today (written before the fix) still counts.
  {
    const server = makeServer();
    const m = server.mod();
    await m.addDoc({}, { userId: 'jo', type: 'follow_up', leadId: 'lead0', dateKey: ymd(today), read: false, createdAt: m.serverTimestamp() });
    await makeTab(server, 'jo').checkAndCreateFollowUpNotifications(LEADS.slice(0, 1));
    ok('an existing legacy doc for today suppresses a new one', followUps(server).length === 1, followUps(server).length + ' docs');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
