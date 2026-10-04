/**
 * NBD Pro — /pro/ask-joe.html auth redirect watcher.
 * Extracted from an inline <script type="module"> so strict CSP can drop
 * 'unsafe-inline'. Waits for NBDAuth to expose an auth instance, then
 * redirects to /pro/index.html if the user signs out.
 */
import { onAuthStateChanged } from '/assets/vendor/firebase/12.19.0/firebase-auth.js';

function waitForAuth() {
  if (window._auth) {
    onAuthStateChanged(window._auth, user => {
      if (!user) window.location.href = '/pro/index.html';
    });
    window.auth = window._auth;
  } else {
    setTimeout(waitForAuth, 50);
  }
}
waitForAuth();
