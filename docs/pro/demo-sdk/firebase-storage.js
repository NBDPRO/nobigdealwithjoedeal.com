// Fake firebase-storage.js for the browser-only sample account (Pro demo
// phase 2). Uploads stay in this tab as object URLs; nothing is sent to Cloud
// Storage. Paths the seed names "sample/<file>" are served from
// /pro/demo-sdk/media/.
import { demoNotice } from './_store.js';

const STORAGE = { __nbdDemo: true, app: null, maxUploadRetryTime: 0, maxOperationRetryTime: 0 };
const _blobs = new Map(); // fullPath -> { blob, url, meta }

class StorageReference {
  constructor(fullPath) {
    this.fullPath = String(fullPath || '').replace(/^\/+/, '');
    const parts = this.fullPath.split('/');
    this.name = parts[parts.length - 1] || '';
    this.bucket = 'sample-account';
    this.storage = STORAGE;
  }
  get parent() { const p = this.fullPath.split('/'); return p.length > 1 ? new StorageReference(p.slice(0, -1).join('/')) : null; }
  get root() { return new StorageReference(''); }
  toString() { return 'gs://sample-account/' + this.fullPath; }
}

export function getStorage(app) { if (app) STORAGE.app = app; return STORAGE; }
export function connectStorageEmulator() {}
export function ref(parent, path) {
  if (parent instanceof StorageReference) return new StorageReference(path ? (parent.fullPath ? parent.fullPath + '/' : '') + path : parent.fullPath);
  return new StorageReference(path || '');
}

function keep(r, blob, meta) {
  const old = _blobs.get(r.fullPath);
  if (old && old.url) { try { URL.revokeObjectURL(old.url); } catch (_) {} }
  let url = '';
  try { url = URL.createObjectURL(blob); } catch (_) {}
  _blobs.set(r.fullPath, { blob, url, meta: Object.assign({ contentType: (blob && blob.type) || 'application/octet-stream' }, meta || {}) });
  return { ref: r, metadata: { fullPath: r.fullPath, name: r.name, size: blob ? blob.size : 0, contentType: blob && blob.type, customMetadata: (meta && meta.customMetadata) || {} } };
}

export async function uploadBytes(r, data, meta) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: (meta && meta.contentType) || 'application/octet-stream' });
  return keep(r, blob, meta);
}
export async function uploadString(r, value, format, meta) {
  let blob;
  if (format === 'data_url') {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/.exec(String(value));
    const type = (m && m[1]) || 'application/octet-stream';
    const body = m ? (m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : decodeURIComponent(m[3])) : '';
    blob = new Blob([body], { type });
  } else if (format === 'base64' || format === 'base64url') {
    const s = format === 'base64url' ? value.replace(/-/g, '+').replace(/_/g, '/') : value;
    blob = new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], { type: (meta && meta.contentType) || 'application/octet-stream' });
  } else {
    blob = new Blob([value], { type: (meta && meta.contentType) || 'text/plain' });
  }
  return keep(r, blob, meta);
}
export function uploadBytesResumable(r, data, meta) {
  const handlers = [];
  let task;
  const p = uploadBytes(r, data, meta).then((snap) => {
    const s = Object.assign({ bytesTransferred: snap.metadata.size, totalBytes: snap.metadata.size, state: 'success', task }, snap);
    task.snapshot = s;
    for (const h of handlers) { try { if (h.next) h.next(s); if (h.complete) h.complete(); } catch (_) {} }
    return s;
  });
  task = {
    snapshot: { bytesTransferred: 0, totalBytes: (data && data.size) || 0, state: 'running', ref: r },
    on(_evt, next, error, complete) {
      handlers.push(typeof next === 'object' && next ? next : { next, error, complete });
      return () => {};
    },
    then(a, b) { return p.then(a, b); },
    catch(b) { return p.catch(b); },
    pause() { return false; }, resume() { return false; }, cancel() { return false; }
  };
  return task;
}

function sampleMediaUrl(fullPath) {
  const m = /^sample\/([\w.-]+)$/.exec(fullPath);
  return m ? '/pro/demo-sdk/media/' + m[1] : '';
}
function notFound(r) { const e = new Error('No file at ' + r.fullPath + ' in the sample account.'); e.code = 'storage/object-not-found'; return e; }

export async function getDownloadURL(r) {
  const hit = _blobs.get(r.fullPath);
  if (hit && hit.url) return hit.url;
  const s = sampleMediaUrl(r.fullPath);
  if (s) return s;
  throw notFound(r);
}
export async function getBlob(r) {
  const hit = _blobs.get(r.fullPath);
  if (hit) return hit.blob;
  const s = sampleMediaUrl(r.fullPath);
  if (s) return (await fetch(s)).blob();
  throw notFound(r);
}
export async function getBytes(r) { return (await getBlob(r)).arrayBuffer(); }
export async function getMetadata(r) {
  const hit = _blobs.get(r.fullPath);
  return { fullPath: r.fullPath, name: r.name, size: hit && hit.blob ? hit.blob.size : 0, contentType: hit ? hit.meta.contentType : '', customMetadata: hit ? (hit.meta.customMetadata || {}) : {} };
}
export async function updateMetadata(r, meta) {
  const hit = _blobs.get(r.fullPath);
  if (hit) Object.assign(hit.meta, meta || {});
  return getMetadata(r);
}
export async function deleteObject(r) {
  const hit = _blobs.get(r.fullPath);
  if (hit && hit.url) { try { URL.revokeObjectURL(hit.url); } catch (_) {} }
  _blobs.delete(r.fullPath);
}
export async function listAll(r) {
  const prefix = r.fullPath ? r.fullPath + '/' : '';
  const items = [];
  const prefixes = new Set();
  for (const p of _blobs.keys()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest.includes('/')) prefixes.add(prefix + rest.split('/')[0]);
    else items.push(new StorageReference(p));
  }
  return { items, prefixes: Array.from(prefixes).map((p) => new StorageReference(p)) };
}
export async function list(r) { return listAll(r); }
export function getStream() {
  demoNotice('Streaming downloads are not in the sample account.');
  throw new Error('Streaming downloads are not in the sample account.');
}
export const __nbdDemo = true;
