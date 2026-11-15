/**
 * tests/lib/supplement-callable-fake.js — run the REAL server callable
 * (functions/supplement-invoice.js createSupplementInvoice) behind a browser
 * sandbox's window._httpsCallable, over the SAME Map the sandbox's fake
 * client Firestore uses. So a browser test that makes an invoice with
 * supplements exercises the server's reads, money and stamps end to end.
 *
 *   installSupplementCallable(W, store, authOf, opts)
 *     W       the sandbox window
 *     store   Map<'col/id' | 'col/id/sub/id', data>
 *     authOf  () => ({ uid, token })   the signed-in user, as the server sees it
 *     opts.callableFail  an Error to throw instead (the callable refused / offline)
 *     opts.claimsByUid   uid → custom claims, for the approver check
 *   → { calls }  every payload the browser sent
 *
 *   TS(ms)          a Firestore-Timestamp-like value (toMillis), kept as is by cloneKeep
 *   cloneKeep(v)    a deep copy that keeps TS values (JSON would flatten them)
 *   APPROVED_AT     a valid approval time: just after the approvals cutoff
 */
'use strict';
const path = require('path');

class TS {
  constructor(ms) { this._ms = ms; }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
}
function cloneKeep(v) {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  if (v instanceof TS) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(cloneKeep);
  const out = {};
  for (const k of Object.keys(v)) { if (v[k] !== undefined) out[k] = cloneKeep(v[k]); }
  return out;
}
const SI_PATH = path.join(__dirname, '..', '..', 'functions', 'supplement-invoice.js');
const APPROVED_AT = new TS(require(SI_PATH).APPROVALS_SINCE_MS + 60000);

const DEFAULT_CLAIMS = {
  carol: { role: 'company_admin', companyId: 'co-a' },
  joe: { role: 'admin' },
  mike: { role: 'manager', companyId: 'co-a' },
  rep1: { role: 'sales_rep', companyId: 'co-a' },
  rep2: { role: 'sales_rep', companyId: 'co-a' },
};

function adminDbOver(store) {
  let seq = 0;
  const snap = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => cloneKeep(store.get(p)) });
  function col(cpath) {
    const q = (ws) => ({
      _q: true,
      where: (f, op, v) => q(ws.concat([[f, v]])),
      _run() {
        const depth = cpath.split('/').length + 1;
        const docs = [];
        for (const [k, v] of store) {
          const parts = k.split('/');
          if (parts.length !== depth || parts.slice(0, -1).join('/') !== cpath) continue;
          if (ws.every(([f, val]) => v[f] === val)) docs.push({ id: parts[parts.length - 1], data: () => cloneKeep(v) });
        }
        return { docs, empty: !docs.length };
      },
    });
    const base = q([]);
    base.doc = (id) => {
      const p = cpath + '/' + (id || ('srv' + (++seq)));
      return { path: p, id: p.split('/').pop(), collection: (sub) => col(p + '/' + sub) };
    };
    return base;
  }
  return {
    collection: (name) => col(name),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: async (r) => (r._q ? r._run() : snap(r.path)),
        create: (r, d) => { if (store.has(r.path)) throw new Error('ALREADY_EXISTS ' + r.path); pending.push(['create', r.path, d]); },
        update: (r, d) => { pending.push(['update', r.path, d]); },
      };
      const out = await fn(tx);
      for (const [k, p, d] of pending) {
        if (k === 'update' && !store.has(p)) throw new Error('NOT_FOUND ' + p);
        store.set(p, k === 'create' ? cloneKeep(d) : Object.assign({}, store.get(p), cloneKeep(d)));
      }
      return out;
    },
  };
}

function installSupplementCallable(W, store, authOf, opts) {
  opts = opts || {};
  const SI = require(SI_PATH);
  const claimsByUid = Object.assign({}, DEFAULT_CLAIMS, opts.claimsByUid || {});
  const calls = [];
  W._functions = { fake: true };
  W._httpsCallable = (fns, name) => async (data) => {
    calls.push({ name, data });
    if (opts.callableFail) throw opts.callableFail;
    if (name !== 'createSupplementInvoice') throw new Error('unexpected callable ' + name);
    const res = await SI.handleCreateSupplementInvoice({ auth: authOf(), data },
      { db: adminDbOver(store), getClaims: async (uid) => claimsByUid[uid] || {} });
    return { data: res };
  };
  return { calls };
}

module.exports = { adminDbOver, installSupplementCallable, TS, cloneKeep, APPROVED_AT, DEFAULT_CLAIMS };
