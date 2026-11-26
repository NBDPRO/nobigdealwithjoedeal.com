'use strict';

/**
 * functions/thursday-projection.js — one call record (roadmap step 17 part C,
 * audit 2026-11-22 §3.3): the Firestore side of thursday-projection-logic.js.
 * The db is passed in (no firebase imports), so tests drive it with a fake.
 *
 *   projectThursdayCall({ db, docId, data })  thursdayCallProcess
 *     (integrations/thursday.js) calls it on every write of thursday_calls/
 *     {docId}. A finished call is upserted into phone_calls/thursday_<id>
 *     (merge: the same doc on every reprocess or inbox action, the other
 *     writers' fields untouched), then linked to its Cube ACR row if one is
 *     already filed. A call not finished (or held) writes nothing.
 *   linkCubeRow({ db, cube })  runIngest (call-center.js) calls it after it
 *     files a new Cube recording: links it to a Thursday projection already
 *     there. Either order ends in the same two linked docs.
 *
 * Both only ever write merge patches to phone_calls; neither deletes a doc,
 * touches Storage, reads audio or calls a model.
 *
 * Review 2026-11-25: a projection call retention already stripped stays
 * stripped (its retention.transcriptStrippedAtMs is read before the write),
 * and a number labeled personal with capture off is projected without its
 * text (contact-labels captureOff, the Cube ingest's rule, with the same
 * "became a customer after the label" exception through the call's lead).
 */

const TP = require('./thursday-projection-logic');
const CL = require('./contact-labels');

const CALLS = 'phone_calls';

/** The phone_calls rows of one owner and number, with their ids. */
async function rowsForNumber(db, userId, digits) {
  if (!userId || !/^\d{10}$/.test(String(digits || ''))) return [];
  const q = await db.collection(CALLS).where('userId', '==', userId).where('phoneDigits', '==', digits).get();
  return q.docs.map((d) => Object.assign({}, d.data() || {}, { id: d.id }));
}

async function writeLink(db, cube, projection, log) {
  const { cubePatch, projectionPatch } = TP.linkPatches(cube, projection);
  const b = db.batch();
  b.set(db.collection(CALLS).doc(cube.id), cubePatch, { merge: true });
  b.set(db.collection(CALLS).doc(projection.id), projectionPatch, { merge: true });
  await b.commit();
  if (log) log.info('thursday_projection_linked', { projectionId: projection.id, cubeId: cube.id, hidden: cubePatch.mergedInto ? 'cube' : 'thursday' });
  return { cubeId: cube.id, projectionId: projection.id, hidden: cubePatch.mergedInto ? 'cube' : 'thursday' };
}

/**
 * @returns {{ state: 'not-projectable'|'written'|'unchanged', id?, linked? }}
 */
/** Is capture off for this call's number (contact label, personal + "stop copying")? */
async function captureOffFor(db, data) {
  if (!TP.projectable(data)) return false;
  const tenant = String(data.companyId || data.userId || '');
  if (!tenant || tenant.includes('/')) return false;
  const labels = await CL.loadLabels(db, tenant);
  const digits = String(data.fromDigits || (data.call && data.call.from) || data.from || '').replace(/\D/g, '').slice(-10);
  if (!labels || !labels[digits]) return false;
  let leads = [];
  const leadId = typeof data.leadId === 'string' && data.leadId && !data.leadId.includes('/') ? data.leadId : '';
  if (leadId) {
    const ls = await db.doc('leads/' + leadId).get();
    if (ls && ls.exists) leads = [ls.data() || {}];
  }
  return CL.captureOff(labels, digits, leads);
}

async function projectThursdayCall({ db, docId, data, log }) {
  if (!TP.projectable(data)) return { state: 'not-projectable' };
  const id = TP.projectionId(data.callId || (data.call && data.call.callId));
  const ref = db.collection(CALLS).doc(id);
  const snap = await ref.get();
  const cur = snap && snap.exists ? (snap.data() || {}) : null;
  const stripped = !!(cur && cur.retention && cur.retention.transcriptStrippedAtMs);
  const next = TP.buildProjection(data, docId, { stripped, captureOff: await captureOffFor(db, data) });
  // Skip a write that changes nothing (the notify update after processing).
  const curSlice = cur ? Object.fromEntries(Object.keys(next).map((k) => [k, cur[k] === undefined ? null : cur[k]])) : null;
  const same = !!cur && TP.sameProjection(curSlice, Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === undefined ? null : v])));
  if (!same) await ref.set(next, { merge: true });
  const out = { state: same ? 'unchanged' : 'written', id };
  const merged = Object.assign({}, cur || {}, next, { id });
  // The projection is hidden behind a kept Cube card (mergedInto = that card):
  // the card is what the Calls screen shows, so an inbox review / un-review
  // (next carries handledAtMs only then) is mirrored onto it. Written only
  // when the two disagree, so a Calls-screen tap (which syncs reviewed, which
  // re-projects here) never bounces back.
  if (next.handledAtMs !== undefined && merged.cubeCallId && merged.mergedInto === merged.cubeCallId) {
    const cref = db.collection(CALLS).doc(merged.cubeCallId);
    const cs = await cref.get();
    const c = cs && cs.exists ? (cs.data() || {}) : null;
    if (c && c.thursdayProjectionId === id && !!c.handledAtMs !== !!next.handledAtMs) {
      await cref.set({ handledAtMs: next.handledAtMs, handledBy: next.handledBy || null }, { merge: true });
      out.cubeHandled = !!next.handledAtMs;
    }
  }
  if (!merged.cubeCallId) {
    const rows = await rowsForNumber(db, next.userId, next.phoneDigits);
    const cube = TP.pickCube(rows, merged, id);
    if (cube) out.linked = await writeLink(db, cube, merged, log);
  }
  return out;
}

/** cube: the Cube ACR phone_calls row just filed, with .id. */
async function linkCubeRow({ db, cube, log }) {
  if (!cube || !cube.id || TP.isProjection(cube) || cube.thursdayProjectionId) return null;
  const rows = await rowsForNumber(db, cube.userId, cube.phoneDigits);
  const projection = TP.pickProjection(rows.filter(TP.isProjection), cube);
  return projection ? writeLink(db, cube, projection, log) : null;
}

module.exports = { projectThursdayCall, linkCubeRow };
