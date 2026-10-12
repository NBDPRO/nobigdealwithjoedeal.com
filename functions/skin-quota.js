/**
 * skin-quota.js — My Skin storage caps (2026-10-11, Jo).
 *
 * Storage Security Rules cannot count or sum objects, so a Storage trigger
 * enforces the totals after the fact:
 *
 *   skins/{uid}/**              a person's own pictures   hard cap 1 GB
 *   companies/{id}/skins/**     a company's background set  cap 500 MB
 *
 * On finalize it lists the owner's prefix, sums the sizes and, when the new
 * object pushed the total over the cap, deletes that object (and its
 * thumbnail sibling). For a company it also writes
 * companies/{id}/skin/config.usage = { bytes, count, rejectedAt? }, the field
 * firestore.rules keeps clients from writing, which the Team backgrounds panel
 * reads for its usage bar and its "storage is full" message. On delete it
 * recomputes the company's usage. Admin SDK only; nothing here is callable.
 *
 * The client's own soft 300 MB personal warning is UI (my-skin-logic.js).
 */
'use strict';

const { onObjectFinalized, onObjectDeleted } = require('firebase-functions/v2/storage');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const Q = require('./skin-quota-logic');

/**
 * The testable core. deps: { listSizes(prefix) -> Promise<number[]>,
 * deleteObjects(names) -> Promise, writeUsage(companyId, usage) -> Promise,
 * now() -> ms }.
 */
async function onFinalized(name, deps) {
  const c = Q.classify(name);
  if (!c) return { ignored: true };
  const sizes = await deps.listSizes(c.prefix);
  const total = Q.sumBytes(sizes.map((s) => ({ size: s })));
  const d = Q.decide(c.kind, total);
  if (d.over) {
    const names = [name];
    if (!/_t$/.test(name)) names.push(name + '_t');   // never leave a thumbnail of a refused picture
    await deps.deleteObjects(names);
    if (c.kind === 'company') {
      const after = await deps.listSizes(c.prefix);
      await deps.writeUsage(c.owner, { bytes: Q.sumBytes(after.map((s) => ({ size: s }))), count: after.length, rejectedAt: deps.now() });
    }
    return { rejected: true, kind: c.kind, total: total, cap: d.cap };
  }
  if (c.kind === 'company') await deps.writeUsage(c.owner, { bytes: total, count: sizes.length });
  return { ok: true, kind: c.kind, total: total };
}

async function onDeleted(name, deps) {
  const c = Q.classify(name);
  if (!c || c.kind !== 'company') return { ignored: true };
  const sizes = await deps.listSizes(c.prefix);
  await deps.writeUsage(c.owner, { bytes: Q.sumBytes(sizes.map((s) => ({ size: s }))), count: sizes.length });
  return { ok: true };
}

function liveDeps(bucketName) {
  const bucket = getStorage().bucket(bucketName);
  const db = getFirestore();
  return {
    async listSizes(prefix) {
      const [files] = await bucket.getFiles({ prefix: prefix, autoPaginate: true });
      return files.map((f) => Number(f.metadata && f.metadata.size) || 0);
    },
    async deleteObjects(names) {
      await Promise.all(names.map((n) => bucket.file(n).delete({ ignoreNotFound: true }).catch(() => {})));
    },
    async writeUsage(companyId, usage) {
      const u = { bytes: usage.bytes, count: usage.count };
      if (usage.rejectedAt) u.rejectedAt = usage.rejectedAt;
      await db.doc('companies/' + companyId + '/skin/config').set({ usage: u, usageUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },
    now() { return Date.now(); },
  };
}

const OPTS = { region: 'us-central1', memory: '256MiB', timeoutSeconds: 120, maxInstances: 10 };

exports.skinQuotaFinalize = onObjectFinalized(OPTS, async (event) => {
  const o = event.data || {};
  const name = String(o.name || '');
  if (!Q.classify(name)) return;
  try {
    const r = await onFinalized(name, liveDeps(o.bucket));
    if (r.rejected) logger.warn('skin quota: object refused', { name: name, kind: r.kind, total: r.total, cap: r.cap });
  } catch (e) { logger.error('skin quota failed', { name: name, message: e && e.message }); }
});

exports.skinQuotaDeleted = onObjectDeleted(OPTS, async (event) => {
  const o = event.data || {};
  const name = String(o.name || '');
  const c = Q.classify(name);
  if (!c || c.kind !== 'company') return;
  try { await onDeleted(name, liveDeps(o.bucket)); }
  catch (e) { logger.error('skin quota (delete) failed', { name: name, message: e && e.message }); }
});

exports._test = { onFinalized, onDeleted };
