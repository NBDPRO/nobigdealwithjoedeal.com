/**
 * roof-rep-net.js — Roof Rep's link to NBD Pro: sign-in, career saves, crew board.
 *
 * Sets window.RoofRepNet once auth settles, then fires 'roofrep:net':
 *   null when signed out (the page shows #rrAuth; the game still runs from
 *   localStorage), otherwise
 *   { uid, name, companyId, avatar,
 *     loadSave() → the saved career or null      (roofRep/{uid}, owner-only)
 *     save(career)                                (roofRep/{uid})
 *     pushScore(row)                              (roofRepScores/{uid})
 *     watchScores(cb) → unsubscribe               (same-company rows only) }
 *
 * avatar comes from the Home game card (userSettings/{uid}.game.avatar), so a
 * rep who built a look there starts Roof Rep with it. Writes are queued one at
 * a time per doc. firestore.rules owns who can read and write what.
 */
import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, collection, query, where, onSnapshot } from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';
import { connectEmulatorsIfLocal } from '../nbd-emulator-connect.js'; // localhost-only, no-op in prod

const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
await connectEmulatorsIfLocal({ auth, db });

let decided = false;
function decide(value) {
  window.RoofRepNet = value;
  if (decided) return;
  decided = true;
  window.dispatchEvent(new Event('roofrep:net'));
}

let chain = Promise.resolve();
function queue(fn) {
  chain = chain.then(fn).catch((e) => { console.warn('[roof-rep] save failed', e && e.code); });
  return chain;
}

onAuthStateChanged(auth, async (user) => {
  const wall = document.getElementById('rrAuth');
  if (!user) { if (wall) wall.hidden = false; decide(null); return; }
  if (wall) wall.hidden = true;
  if (decided) { if (!window.RoofRepNet || window.RoofRepNet.uid !== user.uid) location.reload(); return; }

  let companyId = null, avatar = null;
  try { companyId = (await user.getIdTokenResult()).claims.companyId || null; } catch (_) {}
  try {
    const s = await getDoc(doc(db, 'userSettings', user.uid));
    const game = s.exists() ? (s.data() || {}).game : null;
    avatar = (game && game.avatar) || null;
  } catch (_) {}
  const name = String(user.displayName || '').trim().split(/\s+/)[0].slice(0, 40);

  decide({
    uid: user.uid, name, companyId, avatar,
    loadSave: async () => {
      const s = await getDoc(doc(db, 'roofRep', user.uid));
      return s.exists() ? ((s.data() || {}).save || null) : null;
    },
    save: (career) => queue(() => setDoc(doc(db, 'roofRep', user.uid), { save: career, at: Date.now() })),
    pushScore: (row) => queue(() => setDoc(doc(db, 'roofRepScores', user.uid), Object.assign({}, row, { name, companyId, at: Date.now() }))),
    watchScores: (cb) => {
      const fail = (e) => { console.warn('[roof-rep] crew board', e && e.code); cb([]); };
      if (!companyId) return onSnapshot(doc(db, 'roofRepScores', user.uid), (s) => cb(s.exists() ? [Object.assign({ id: s.id }, s.data())] : []), fail);
      return onSnapshot(query(collection(db, 'roofRepScores'), where('companyId', '==', companyId)),
        (qs) => cb(qs.docs.map((d) => Object.assign({ id: d.id }, d.data()))), fail);
    },
  });
});
