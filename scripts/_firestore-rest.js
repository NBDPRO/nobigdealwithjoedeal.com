/**
 * scripts/_firestore-rest.js — a minimal Firestore client over the REST API,
 * for scripts run with a short-lived access token (NBD_ACCESS_TOKEN) instead of
 * Application Default Credentials. firebase-admin refuses a bare token for
 * Firestore, and its gRPC transport bypasses an HTTPS proxy; this adapter uses
 * plain fetch, so it also works where a proxy adds the Authorization header.
 *
 * Covers only what scripts/prod-switches.js and scripts/merge-catalog-costs.js
 * use: db.doc(path).get() -> { exists, data() }, ref.set(data, { merge }),
 * ref.update(fieldPath, value, ...), FieldPath, serverTimestamp().
 * 2026-11-09: plus the one query scripts/backfill-q11-task-summaries.js pages
 * with: db.collectionGroup(id).orderBy('__name__').limit(n).startAfter(snap)
 * .get() -> { empty, size, docs: [{ id, ref, data() }] } (documents:runQuery).
 * The token is sent in a header only; it is never logged.
 */
'use strict';

const SERVER_TS = Object.freeze({ __restServerTimestamp: true });

class FieldPath {
  constructor(...segments) {
    if (!segments.length || segments.some((s) => typeof s !== 'string' || !s)) throw new Error('FieldPath needs non-empty string segments');
    this.segments = segments;
  }
  // Firestore field path syntax: a segment that is not a plain identifier is backtick-quoted.
  toString() { return this.segments.map(quoteSeg).join('.'); }
}
function quoteSeg(s) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'; }

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('cannot store a non-finite number');
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  throw new Error('cannot store a ' + typeof v);
}
function encodeFields(o) { const f = {}; for (const k of Object.keys(o)) f[k] = encode(o[k]); return f; }

function decode(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decode);
  if ('mapValue' in v) return decodeFields((v.mapValue && v.mapValue.fields) || {});
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return undefined;
}
function decodeFields(f) { const o = {}; for (const k of Object.keys(f || {})) o[k] = decode(f[k]); return o; }

/** Split top-level server-timestamp sentinels out of a set() payload. */
function splitTransforms(data) {
  const plain = {}, ts = [];
  for (const k of Object.keys(data)) { if (data[k] === SERVER_TS) ts.push(k); else plain[k] = data[k]; }
  return { plain, ts };
}

function restFirestore({ projectId, token, fetchImpl }) {
  if (!projectId) throw new Error('projectId is required');
  const t = String(token || '').trim();
  if (!t) throw new Error('NBD_ACCESS_TOKEN is empty');
  const f = fetchImpl || globalThis.fetch;
  const root = 'projects/' + projectId + '/databases/(default)/documents';
  const base = 'https://firestore.googleapis.com/v1/';
  const headers = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };

  async function call(method, url, body) {
    const r = await f(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* keep text */ }
    return { status: r.status, json, text };
  }
  async function commit(writes) {
    const r = await call('POST', root + ':commit', { writes });
    if (r.status !== 200) throw new Error('Firestore commit failed: HTTP ' + r.status + ' ' + ((r.json && r.json.error && r.json.error.message) || '').slice(0, 300));
    return r.json;
  }

  function doc(path) {
    if (typeof path !== 'string' || !path || path.split('/').length % 2 !== 0) throw new Error('bad document path: ' + path);
    const name = root + '/' + path;
    return {
      path,
      async get() {
        const r = await call('GET', name.split('/').map(encodeURIComponent).join('/').replace('%28default%29', '(default)'));
        if (r.status === 404) return { exists: false, data: () => undefined };
        if (r.status !== 200) throw new Error('Firestore read of ' + path + ' failed: HTTP ' + r.status + ' ' + ((r.json && r.json.error && r.json.error.message) || '').slice(0, 300));
        const data = decodeFields((r.json && r.json.fields) || {});
        return { exists: true, data: () => data };
      },
      async set(data, opt) {
        const { plain, ts } = splitTransforms(data || {});
        const w = { update: { name, fields: encodeFields(plain) } };
        if (opt && opt.merge) w.updateMask = { fieldPaths: Object.keys(plain).map(quoteSeg) };
        if (ts.length) w.updateTransforms = ts.map((k) => ({ fieldPath: quoteSeg(k), setToServerValue: 'REQUEST_TIME' }));
        return commit([w]);
      },
      // update(fieldPath, value, fieldPath, value, ...): the document must exist.
      async update(...args) {
        if (!args.length || args.length % 2) throw new Error('update takes fieldPath, value pairs');
        const fields = {}, mask = [], ts = [];
        for (let i = 0; i < args.length; i += 2) {
          const fp = args[i] instanceof FieldPath ? args[i] : new FieldPath(...String(args[i]).split('.'));
          if (args[i + 1] === SERVER_TS) { ts.push(fp.toString()); continue; }
          let cur = fields;
          fp.segments.forEach((s, j) => {
            if (j === fp.segments.length - 1) cur[s] = args[i + 1];
            else cur = (cur[s] = (cur[s] && typeof cur[s] === 'object' ? cur[s] : {}));
          });
          mask.push(fp.toString());
        }
        const w = { update: { name, fields: encodeFields(fields) }, updateMask: { fieldPaths: mask }, currentDocument: { exists: true } };
        if (ts.length) w.updateTransforms = ts.map((p) => ({ fieldPath: p, setToServerValue: 'REQUEST_TIME' }));
        return commit([w]);
      },
    };
  }

  // A collection-group query paged by document name, the one shape the
  // backfill scripts use. No filters: a collection-group filter needs an
  // index scope the project may not have; the caller filters what it reads.
  function collectionGroup(collectionId) {
    if (typeof collectionId !== 'string' || !collectionId || collectionId.includes('/')) throw new Error('bad collection id: ' + collectionId);
    const make = (lim, afterPath) => ({
      orderBy(field) { if (field !== '__name__') throw new Error('only orderBy(\'__name__\') is supported'); return make(lim, afterPath); },
      limit(n) { if (!Number.isInteger(n) || n < 1) throw new Error('limit must be a positive integer'); return make(n, afterPath); },
      startAfter(snap) { const p = snap && snap.ref ? snap.ref.path : snap; return make(lim, String(p)); },
      async get() {
        const sq = { from: [{ collectionId, allDescendants: true }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }] };
        if (lim) sq.limit = lim;
        if (afterPath) sq.startAt = { values: [{ referenceValue: root + '/' + afterPath }], before: false };
        const r = await call('POST', root + ':runQuery', { structuredQuery: sq });
        if (r.status !== 200) throw new Error('Firestore query of ' + collectionId + ' failed: HTTP ' + r.status + ' ' + ((r.json && r.json.error && r.json.error.message) || '').slice(0, 300));
        const docs = (Array.isArray(r.json) ? r.json : []).filter((x) => x && x.document).map((x) => {
          const path = x.document.name.slice(root.length + 1);
          const data = decodeFields(x.document.fields || {});
          return { id: path.split('/').pop(), ref: doc(path), exists: true, data: () => data };
        });
        return { empty: !docs.length, size: docs.length, docs };
      },
    });
    return make(0, null);
  }
  return { doc, collectionGroup };
}

module.exports = { restFirestore, FieldPath, serverTimestamp: () => SERVER_TS, encode, decode, quoteSeg, SERVER_TS };
