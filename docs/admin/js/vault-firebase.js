  import { initializeApp } from '/assets/vendor/firebase/10.12.2/firebase-app.js';
  import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/10.12.2/firebase-auth.js';
  import { getFirestore, doc, setDoc, getDoc, collection, getDocs, query, where, orderBy, limit } from '/assets/vendor/firebase/10.12.2/firebase-firestore.js';

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

  // ADMIN AUTH GATE — custom claims only. No Firestore role field, no email whitelist.
  // Roles are set server-side via `admin.auth().setCustomUserClaims()` and
  // cannot be self-elevated by any client.
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace('/pro/login.html?redirect=/admin/vault.html');
      return;
    }
    try {
      // Force token refresh so freshly-granted admin claims are picked up.
      const result = await user.getIdTokenResult(true);
      if (result.claims.role !== 'admin') {
        window.location.replace('/pro/dashboard.html');
        return;
      }
    } catch (e) {
      window.location.replace('/pro/login.html?redirect=/admin/vault.html');
      return;
    }
    document.documentElement.style.display = '';
    window.dispatchEvent(new Event('firebase-ready'));
  });

  // Expose to window for non-module scripts
  window._auth = auth;
  window._db = db;
  window._firestore = { doc, setDoc, getDoc, collection, getDocs, query, where, orderBy, limit };
  window._authState = onAuthStateChanged;
