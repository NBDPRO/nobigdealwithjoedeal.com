/**
 * NBD Pro — /pro/diagnostic.html controller.
 *
 * Extracted from an inline <script type="module"> so strict CSP can drop
 * 'unsafe-inline'. Also swapped the test-row builder from innerHTML string
 * interpolation to DOM builders, because the `detail` field can include
 * raw error messages and JSON.stringify output that occasionally contain
 * angle brackets — self-XSS only, but clean is clean.
 */
import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/12.19.0/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where, orderBy } from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';
import { connectEmulatorsIfLocal } from '../nbd-emulator-connect.js'; // Audit #3: localhost-only, no-op in prod

const results = document.getElementById('results');

function log(test, pass, detail) {
  const div = document.createElement('div');
  div.className = 'test ' + (pass ? 'pass' : 'fail');

  const header = document.createElement('strong');
  header.textContent = (pass ? '✓ ' : '✗ ') + test;
  div.appendChild(header);

  const pre = document.createElement('pre');
  pre.textContent = detail;
  div.appendChild(pre);

  results.appendChild(div);
}

const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};

try {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  await connectEmulatorsIfLocal({ auth, db }); // Audit #3: localhost-only, no-op in prod
  log('Firebase Init', true, 'Connected successfully');

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      log('Auth State', true, `Logged in as: ${user.email}`);
      try {
        // Owner-scope the query: the /leads read rule is isOwner(userId)||isAdmin(),
        // so an unfiltered collection-wide read is permission-denied for normal
        // (non-platform-admin) users — this self-test always FAILed with
        // "Missing or insufficient permissions", falsely reporting the DB broken.
        // Filtering by the signed-in uid matches the rule (and the existing
        // leads [userId,createdAt] composite index serves it).
        const snap = await getDocs(query(collection(db, 'leads'), where('userId', '==', user.uid), orderBy('createdAt', 'desc')));
        const leads = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => !l.deleted);
        log('Firestore - Leads', true, `Found ${leads.length} active leads:\n${JSON.stringify(leads.slice(0, 3), null, 2)}`);

        setTimeout(() => {
          const funcs = ['goTo', 'nbdPickerOpen', 'toggleNavSection', 'openLeadModal'];
          const missing = funcs.filter(f => typeof window[f] !== 'function');
          if (missing.length === 0) {
            log('Window Functions', true, `All ${funcs.length} critical functions exposed`);
          } else {
            log('Window Functions', false, `MISSING: ${missing.join(', ')}`);
          }
        }, 1000);
      } catch (e) {
        log('Firestore - Leads', false, `Error: ${e.message}\n${e.stack}`);
      }
    } else {
      log('Auth State', false, 'Not logged in - diagnostic requires authentication.');
      setTimeout(() => { window.location.href = '/pro/login.html'; }, 2000);
    }
  });

} catch (e) {
  log('Firebase Init', false, `Error: ${e.message}\n${e.stack}`);
}
