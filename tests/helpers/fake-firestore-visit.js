'use strict';
/**
 * tests/helpers/fake-firestore-visit.js - an in-memory Firestore + Storage for
 * the visit-capture tests. Unlike the loose fakes that match equality only,
 * this one HONOURS where() (==, in, <, <=, >, >=), orderBy, startAfter and
 * limit, on collections and collection groups, so a query that is wrong in the
 * code is wrong here too. It never enforces indexes (neither does the
 * emulator); tests/visit-capture-pipeline-2026-10-13.test.js checks every
 * query shape against firestore.indexes.json separately.
 *
 * Writes are logged in order (db.log) so a test can assert that the
 * transcript was saved BEFORE the notes call.
 */

const FV_TS = { __serverTimestamp: true };

function toCmp(v) {
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return v;
}

function makeDb(seed) {
  let txChain = Promise.resolve();
  const docs = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const log = [];
  const stats = { queries: [] };

  const idOf = (p) => p.split('/').pop();
  const parentOf = (p) => p.split('/').slice(0, -1).join('/');
  const snapOf = (p) => ({
    id: idOf(p), exists: docs.has(p), ref: refOf(p),
    data: () => (docs.has(p) ? JSON.parse(JSON.stringify(docs.get(p))) : undefined),
  });
  function applyMerge(p, v, merge) {
    const cur = docs.get(p) || {};
    const next = merge ? Object.assign({}, cur) : {};
    Object.keys(v).forEach((k) => { next[k] = v[k] && v[k].__serverTimestamp ? 'SERVER_TS' : v[k]; });
    docs.set(p, JSON.parse(JSON.stringify(next)));
  }
  function refOf(p) {
    return {
      id: idOf(p), path: p, parent: { path: parentOf(p), parent: { id: parentOf(p).split('/').slice(-2, -1)[0] || null, path: parentOf(parentOf(p)) } },
      async get() { return snapOf(p); },
      async set(v, opt) { log.push(['set', p, Object.keys(v)]); applyMerge(p, v, !!(opt && opt.merge)); },
      async update(v) { log.push(['update', p, Object.keys(v)]); if (!docs.has(p)) { const e = new Error('NOT_FOUND'); e.code = 5; throw e; } applyMerge(p, v, true); },
      async create(v) { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } log.push(['create', p, Object.keys(v)]); applyMerge(p, v, false); },
      async delete() { log.push(['delete', p]); docs.delete(p); },
    };
  }
  const OPS = {
    '==': (a, b) => a === b,
    'in': (a, b) => Array.isArray(b) && b.indexOf(a) !== -1,
    '<': (a, b) => a != null && a < b,
    '<=': (a, b) => a != null && a <= b,
    '>': (a, b) => a != null && a > b,
    '>=': (a, b) => a != null && a >= b,
  };
  function query(match, label, filters, orders, lim, after) {
    const q = {
      where: (f, op, v) => query(match, label, filters.concat([[f, op, toCmp(v)]]), orders, lim, after),
      orderBy: (f, dir) => query(match, label, filters, orders.concat([[f, dir || 'asc']]), lim, after),
      limit: (n) => query(match, label, filters, orders, n, after),
      startAfter: (d) => query(match, label, filters, orders, lim, d),
      async get() {
        stats.queries.push({ label, filters: filters.map((x) => x.slice(0, 2).join(' ')), orderBy: orders.map((o) => o[0]) });
        let rows = [...docs.entries()].filter(([p]) => match(p));
        rows = rows.filter(([, v]) => filters.every(([f, op, val]) => {
          const x = toCmp(v[f]);
          if (!OPS[op]) throw new Error('fake: unsupported op ' + op);
          return OPS[op](x, val);
        }));
        if (orders.length) {
          const [f, dir] = orders[0];
          rows.sort((a, b) => {
            const x = toCmp(a[1][f]), y = toCmp(b[1][f]);
            if (x === y) return a[0] < b[0] ? -1 : 1;
            return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
          });
        }
        if (after) {
          const i = rows.findIndex(([p]) => p === after.ref.path);
          if (i >= 0) rows = rows.slice(i + 1);
        }
        if (lim != null) rows = rows.slice(0, lim);
        const dsnaps = rows.map(([p]) => snapOf(p));
        return { empty: dsnaps.length === 0, size: dsnaps.length, docs: dsnaps, forEach: (fn) => dsnaps.forEach(fn) };
      },
    };
    return q;
  }
  const db = {
    docs, log, stats,
    doc: (p) => refOf(p),
    collection: (name) => Object.assign(
      query((p) => parentOf(p) === name, 'c:' + name, [], [], null, null),
      { doc: (id) => refOf(name + '/' + id), add: async (v) => { const id = 'auto' + docs.size; applyMerge(name + '/' + id, v, false); return refOf(name + '/' + id); } }
    ),
    collectionGroup: (name) => query((p) => { const parts = p.split('/'); return parts.length % 2 === 0 && parts[parts.length - 2] === name; }, 'g:' + name, [], [], null, null),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    runTransaction(fn) {
      // serialised, like Firestore's contention retry: the second caller sees the first's writes
      const run = txChain.then(() => runTx(fn));
      txChain = run.catch(() => {});
      return run;
    },
  };
  async function runTx(fn) {
      const writes = [];
      const tx = {
        get: async (r) => r.get(),
        set: (r, v, opt) => { writes.push(() => r.set(v, opt)); },
        update: (r, v) => { writes.push(() => r.update(v)); },
        create: (r, v) => { writes.push(() => r.create(v)); },
        delete: (r) => { writes.push(() => r.delete()); },
      };
      // Transactions here are serialised by the single-threaded event loop; the
      // lease test relies on tx.get + tx.set being applied together.
      const out = await fn(tx);
      for (const w of writes) await w();
      return out;
  }
  return db;
}

function makeBucket(files, opts) {
  const o = opts || {};
  const store = new Map(Object.entries(files || {}).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(String(v))]));
  const calls = { exists: [], download: [], delete: [] };
  return {
    store, calls,
    file: (p) => ({
      async exists() { calls.exists.push(p); if (o.existsThrows) throw new Error('storage down'); return [store.has(p)]; },
      async getMetadata() { return [{ size: store.has(p) ? store.get(p).length : 0 }]; },
      async download() { calls.download.push(p); if (!store.has(p)) throw new Error('No such object'); return [store.get(p)]; },
      async delete(opt) {
        calls.delete.push(p);
        if (o.deleteThrows) throw new Error('delete failed');
        if (!store.has(p) && !(opt && opt.ignoreNotFound)) throw new Error('No such object');
        store.delete(p);
      },
    }),
  };
}

module.exports = { makeDb, makeBucket, FV_TS };
