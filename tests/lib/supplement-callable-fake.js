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
 *   → { calls }  every payload the browser sent
 */
'use strict';
const path = require('path');

function adminDbOver(store) {
  let seq = 0;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => clone(store.get(p)) });
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
          if (ws.every(([f, val]) => v[f] === val)) docs.push({ id: parts[parts.length - 1], data: () => clone(v) });
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
        store.set(p, k === 'create' ? clone(d) : Object.assign({}, store.get(p), clone(d)));
      }
      return out;
    },
  };
}

function installSupplementCallable(W, store, authOf, opts) {
  opts = opts || {};
  const SI = require(path.join(__dirname, '..', '..', 'functions', 'supplement-invoice.js'));
  const calls = [];
  W._functions = { fake: true };
  W._httpsCallable = (fns, name) => async (data) => {
    calls.push({ name, data });
    if (opts.callableFail) throw opts.callableFail;
    if (name !== 'createSupplementInvoice') throw new Error('unexpected callable ' + name);
    const res = await SI.handleCreateSupplementInvoice({ auth: authOf(), data }, { db: adminDbOver(store) });
    return { data: res };
  };
  return { calls };
}

module.exports = { adminDbOver, installSupplementCallable };
