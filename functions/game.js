/**
 * game.js — getGameCard (onCall): the optional game card's numbers, derived
 * on request from the caller's OWN records (functions/game-logic.js). Nothing
 * is stored, so there's nothing to edit or farm. Read-only.
 *
 * Reads: leads/{id}/tasks (collection group, userId — the tasks.userId
 * COLLECTION_GROUP override in firestore.indexes.json), phone_calls and
 * phone_text_days (userId), leads (userId), invoices (createdBy).
 * If the task index is still building right after a deploy, the card is
 * returned without tasks and says so (partial), rather than failing.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const G = require('./game-logic');
const { paymentsOf } = require('./agent-mcp-logic');

const CAP = 3000; // per collection — far above one rep's records

async function rows(q) {
  const snap = await q.limit(CAP).get();
  const out = [];
  snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data())));
  return out;
}

async function gameCard({ db, auth, nowMs }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = auth.uid;
  const partial = [];
  let tasks = [];
  try { tasks = await rows(db.collectionGroup('tasks').where('userId', '==', uid)); }
  catch (e) { partial.push('tasks'); }
  const [calls, texts, leads, invoices] = await Promise.all([
    rows(db.collection('phone_calls').where('userId', '==', uid)).catch(() => { partial.push('calls'); return []; }),
    rows(db.collection('phone_text_days').where('userId', '==', uid)).catch(() => { partial.push('texts'); return []; }),
    rows(db.collection('leads').where('userId', '==', uid)).catch(() => { partial.push('leads'); return []; }),
    rows(db.collection('invoices').where('createdBy', '==', uid)).catch(() => { partial.push('invoices'); return []; }),
  ]);
  const card = G.buildCard({ uid, nowMs, tasks, calls: calls.concat(texts), leads, invoices, paymentsOf });
  return Object.assign(card, { partial });
}

exports.getGameCard = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 60, maxInstances: 10 },
  (request) => gameCard({ db: getFirestore(), auth: request.auth, nowMs: Date.now() })
);

exports._test = { gameCard };
