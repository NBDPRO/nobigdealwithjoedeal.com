/**
 * integrations/mesh-hail.js — nightly MRMS MESH hail swaths → hail_mesh/{ymd}
 *
 * Once a morning, fetch NOAA's 24-hour "Maximum Estimated Size of Hail" grid
 * (the file valid 12:00 UTC, i.e. the storm day that just ended), cut it to
 * the Cincinnati / NKY service area, trace the 0.75 / 1 / 1.5 / 2 inch bands
 * into polygons and store them in `hail_mesh/{YYYY-MM-DD}`, keyed by the day
 * the 24-hour window ENDS. The decoding and tracing are pure and tested
 * (mesh-hail-logic.js, tests/mesh-hail-2026-11-04.test.js).
 *
 * DARK: does nothing unless `feature_flags/global.meshHailEnabled === true`
 * (Jo flips it in the console; Claude cannot write production flags). A day
 * with no hail ≥ 0.75" still writes a doc ({ maxIn, polygonCount: 0 }) so
 * "ran and saw nothing" is distinguishable from "never ran".
 *
 * Data: public NOAA bucket on AWS, keyless, ~350 KB per file
 * (registry.opendata.aws/noaa-mrms-pds). NOAA asks for attribution, which
 * the map title carries ("NOAA MRMS radar estimate").
 *
 * Readers: signed-in, non-anonymous users read hail_mesh (firestore.rules);
 * nobody writes it from a client. Public NOAA data, no tenant data inside.
 */
'use strict';

const zlib = require('zlib');
const { onSchedule } = require('./heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getFlags } = require('./killswitch');
const { retryTransient } = require('./retry-transient');
const M = require('./mesh-hail-logic');

const FETCH_TIMEOUT_MS = 30000;

// Today's date in UTC as 'YYYY-MM-DD' — the 12:00 UTC file is named by the
// UTC day it is valid on.
function utcYmd(now) {
  const d = now || new Date();
  return d.getUTCFullYear() + '-' + M._pad2(d.getUTCMonth() + 1) + '-' + M._pad2(d.getUTCDate());
}

async function fetchOk(url, as) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) { const e = new Error('MRMS ' + res.status + ' ' + url); e.status = res.status; throw e; }
  return as === 'text' ? res.text() : Buffer.from(await res.arrayBuffer());
}

/**
 * One day, end to end. Exported for the backfill script and the test seam;
 * `deps` lets a test inject fetch + db.
 */
async function runMeshDay(ymd, deps) {
  const d = deps || {};
  const db = d.db || getFirestore();
  const get = d.fetchOk || fetchOk;
  const keys = M.parseListXml(await get(M.listUrl(ymd), 'text'));
  const key = M.pickFile(keys, M.compactYmd(ymd));
  if (!key) return { ymd, status: 'no-file' };
  const grib = zlib.gunzipSync(await get(M.fileUrl(key), 'buffer'));
  const crop = M.cropMm(M.parseGrib2(grib), M.SERVICE_BBOX);
  const doc = M.buildDayDoc(crop, { ymd, key });
  await db.doc('hail_mesh/' + ymd).set(Object.assign(doc, { fetchedAt: FieldValue.serverTimestamp() }));
  return { ymd, status: 'ok', maxIn: doc.maxIn, polygonCount: doc.polygonCount };
}

exports.meshHailCron = onSchedule(
  {
    region: 'us-central1',
    // 13:20 UTC: the 12:00 file is normally on S3 within minutes; this leaves
    // an hour of slack and still lands before Jo's morning.
    schedule: '20 13 * * *',
    timeZone: 'Etc/UTC',
    timeoutSeconds: 120,
    memory: '512MiB'
  },
  () => meshHailHandler()
);

// The scheduled body, with seams for the test. Returns what it did.
async function meshHailHandler(deps) {
  const d = deps || {};
  const flags = await (d.getFlags || getFlags)();
  if (flags.meshHailEnabled !== true) {
    logger.info('meshHailCron: dark (feature_flags/global.meshHailEnabled is not true)');
    return { status: 'dark' };
  }
  const ymd = utcYmd(d.now);
  const r = await retryTransient(() => runMeshDay(ymd, d), d.retry);
  if (r.status !== 'ok') {
    // A missing file is a NOAA-side gap, not our failure — but it must be
    // loud enough to notice if it repeats, and must not write a fake
    // "no hail" doc.
    logger.warn('meshHailCron: no MESH file for ' + ymd, r);
    return r;
  }
  logger.info('meshHailCron: wrote hail_mesh/' + ymd, r);
  return r;
}

exports._test = { utcYmd, runMeshDay, fetchOk, meshHailHandler };
