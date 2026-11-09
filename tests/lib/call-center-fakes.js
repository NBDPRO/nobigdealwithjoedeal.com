/**
 * tests/lib/call-center-fakes.js — an in-memory Firestore, Storage bucket and
 * Drive client for functions/call-center.js runIngest / runTranscribe
 * (Call to Close P2, multi-tenant call feed, 2026-11-09).
 *
 * The Firestore fake records every write in order (`log`), so a test can pin
 * exactly what a run filed. Queries support == filters (any number), orderBy
 * (startedAtMs desc, the only order call-center.js asks for) and limit.
 * Names and numbers are invented (555 exchange).
 */
'use strict';

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function fakeDb(seed) {
  const docs = new Map();
  for (const [k, v] of Object.entries(seed || {})) docs.set(k, v);
  const log = [];
  const snapOf = (p) => ({ exists: docs.has(p), id: p.split('/').pop(), ref: mk(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      async get() { return snapOf(p); },
      async set(v, opt) {
        log.push({ op: opt && opt.merge ? 'merge' : 'set', path: p, data: clone(v) });
        docs.set(p, opt && opt.merge ? Object.assign({}, docs.get(p) || {}, v) : v);
      },
      async create(v) {
        if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; }
        log.push({ op: 'create', path: p, data: clone(v) });
        docs.set(p, v);
      },
      async delete() { log.push({ op: 'delete', path: p }); docs.delete(p); },
      collection: (name) => coll(p + '/' + name),
    };
  }
  function query(name, filters, lim) {
    return {
      where: (f, _op, v) => query(name, filters.concat([[f, v]]), lim),
      orderBy: () => query(name, filters, lim),
      limit: (n) => query(name, filters, n),
      get: async () => {
        const depth = name.split('/').length + 1;
        const rows = [...docs.entries()]
          .filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === depth && filters.every(([f, val]) => v && v[f] === val))
          .sort((a, b) => ((b[1] && b[1].startedAtMs) || 0) - ((a[1] && a[1].startedAtMs) || 0))
          .slice(0, lim || 1e9);
        const ds = rows.map(([k]) => snapOf(k));
        return { size: ds.length, empty: !ds.length, docs: ds, forEach: (fn) => ds.forEach(fn) };
      },
    };
  }
  function coll(name) {
    return Object.assign(query(name, [], null), {
      doc: (id) => mk(name + '/' + id),
      add: async (v) => { const id = 'auto' + docs.size; log.push({ op: 'add', path: name, data: clone(v) }); docs.set(name + '/' + id, v); return { id }; },
    });
  }
  return {
    docs, log,
    doc: mk,
    collection: coll,
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o) }),
  };
}

function fakeBucket() {
  const saved = new Map();
  const deleted = [];
  return {
    saved, deleted,
    file: (p) => ({
      save: async (b, opts) => { saved.set(p, { bytes: b.length, contentType: opts && opts.contentType }); },
      download: async () => [Buffer.from('audio:' + p)],
      delete: async () => { deleted.push(p); saved.delete(p); },
    }),
  };
}

const FOLDER = 'application/vnd.google-apps.folder';

/**
 * A Drive client. trees: { <rootFolderId>: { name?, days: { 'YYYY-MM-DD': [file…] } } }.
 * The folder-name search ("Cube ACR") finds every root whose name is 'Cube ACR'.
 */
function fakeDrive(trees) {
  const requests = [];
  const byId = new Map();
  const children = new Map();
  for (const [rootId, t] of Object.entries(trees || {})) {
    byId.set(rootId, { id: rootId, name: t.name || 'Cube ACR', mimeType: FOLDER });
    const days = [];
    for (const [ymd, files] of Object.entries(t.days || {})) {
      const dayId = rootId + '_' + ymd;
      days.push({ id: dayId, name: ymd, mimeType: FOLDER });
      children.set(dayId, files.map((f) => Object.assign({ mimeType: 'audio/mpeg' }, f)));
      for (const f of files) byId.set(f.id, f);
    }
    children.set(rootId, days);
  }
  return {
    requests,
    request: async (o) => {
      requests.push(clone({ url: o.url, params: o.params }));
      if (o.params && o.params.alt === 'media') {
        const id = decodeURIComponent(o.url.split('/files/')[1]);
        const f = byId.get(id);
        if (f && f.sidecar) return { data: new TextEncoder().encode(f.sidecar).buffer };
        return { data: new Uint8Array([1, 2, 3]).buffer };
      }
      const q = o.params.q;
      const nm = /^name = '([^']+)'/.exec(q);
      if (nm) return { data: { files: [...byId.values()].filter((f) => f.mimeType === FOLDER && f.name === nm[1] && children.has(f.id) && trees[f.id]) } };
      const parent = /^'([^']+)' in parents/.exec(q)[1];
      return { data: { files: (children.get(parent) || []).filter((f) => !/mimeType = /.test(q) || f.mimeType === FOLDER) } };
    },
  };
}

module.exports = { fakeDb, fakeBucket, fakeDrive, clone, FOLDER };
