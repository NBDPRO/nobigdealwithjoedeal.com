  import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
  import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/12.19.0/firebase-auth.js';
  const app = initializeApp({
    apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
    authDomain: "nobigdeal-pro.firebaseapp.com",
    projectId: "nobigdeal-pro",
    storageBucket: "nobigdeal-pro.firebasestorage.app",
    messagingSenderId: "717435841570",
    appId: "1:717435841570:web:c2338e11052c96fde02e7b"
  });
  const auth = getAuth(app);
  window._auth = auth;   // expose for non-module scripts (adminAI token)
  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.replace('login.html'); return; }
    try {
      const result = await user.getIdTokenResult(true);
      if (result.claims.role !== 'admin') { window.location.replace('/pro/dashboard.html'); return; }
    } catch (e) { window.location.replace('login.html'); return; }
    document.documentElement.style.display = '';
  });
