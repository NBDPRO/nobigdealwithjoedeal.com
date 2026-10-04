// vault-auth.module.js — auth bootstrap for /pro/vault
// Extracted from inline <script type="module"> in vault.html so the
// strict CSP (script-src 'self' with no unsafe-inline) lets it run.
import { NBDAuth } from '/pro/js/nbd-auth.js';
// vault-page.js boots the entire engine off a `firebase-ready` window event and
// reads the modular Firestore helpers from window._firestore (doc/getDoc/setDoc/
// ...). nbd-auth.js only imports {doc,getDoc}, never sets window._firestore, and
// never dispatches that event — so /pro/vault was DEAD on load: loadFromFirestore
// never ran (Overview stuck on "Loading…") and every save bailed at the
// `if (!firestore || !db)` guard. Mirror docs/admin/vault.html: expose the full
// helper set (crucially incl. setDoc, which nbd-auth.js does NOT import — used by
// saveToFirestore) and dispatch the event once auth is confirmed. ES modules are
// URL-cached, so importing the same gstatic 10.12.2 firestore module nbd-auth.js
// uses gives helpers bound to the same Firestore instance (NBDAuth.db).
import { doc, getDoc, setDoc, collection, getDocs, query, where, orderBy, limit }
  from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';

window._nbdAuth = NBDAuth.init({
  requiredPlan: 'growth',
  requireAdmin: true,
  onReady: (user) => {
    window._authUser = user;
    window._currentUser = user;          // AI paths read window._currentUser first
    window._db = NBDAuth.db;
    window._firestore = { doc, getDoc, setDoc, collection, getDocs, query, where, orderBy, limit };
    console.log('NBD Auth ready — admin:', NBDAuth.isAdmin);
    window.dispatchEvent(new Event('firebase-ready'));
  }
});
