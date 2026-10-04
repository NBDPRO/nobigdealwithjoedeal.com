// pricing-page.module.js — Stripe checkout + FAQ accordion + auth state
//
// Extracted from the inline <script type="module"> formerly inline in
// docs/pro/pricing.html (CSP `script-src 'self'` blocks inline blocks,
// including type="module"; serving as a same-origin .js file passes).
// Wires the data-pr-action delegate that the page's buttons already use.

import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';

// pricing.html now loads js/toast.js before this module.
function _ppNotify(msg, kind) {
  if (typeof window.showToast === 'function') { window.showToast(msg, kind || 'info'); return; }
  if (kind === 'error') console.error('[pricing]', msg); else console.log('[pricing]', msg);
}
import { connectEmulatorsIfLocal, getFunctionsBase } from './nbd-emulator-connect.js'; // Audit #3: localhost-only, no-op in prod

const app = initializeApp({
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro"
});
const auth = getAuth(app);
const db = getFirestore(app);
await connectEmulatorsIfLocal({ auth, db }); // Audit #3: localhost-only, no-op in prod

// Stripe Checkout's cancel_url lands here with ?cancelled=true — acknowledge
// it so the user knows nothing was charged (previously the flag was ignored
// and the page rendered as if they'd never left).
const checkoutCancelled = new URLSearchParams(location.search).get('cancelled') === 'true';
if (checkoutCancelled) {
  const note = document.createElement('div');
  note.setAttribute('role', 'status');
  note.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;background:#1A3057;color:#fff;border:1px solid #BD5728;border-radius:8px;padding:10px 18px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.35);';
  note.textContent = 'Checkout cancelled — you have not been charged.';
  document.body.appendChild(note);
  setTimeout(() => note.remove(), 6000);
  history.replaceState(null, '', location.pathname); // don't re-toast on reload
}

window.subscribe = async function(plan, evt) {
  // Resolve the button from the explicit event arg (preferred) with a fallback
  // to window.event for legacy onclick calls. Never rely on the undeclared
  // global `event` identifier — that silently fails under strict mode.
  const btn = (evt && evt.target) || (typeof window !== 'undefined' && window.event && window.event.target) || null;
  const originalLabel = btn ? btn.textContent : '';

  // Check if user is signed in
  const user = auth.currentUser;
  if (!user) {
    // A signed-out visitor on the pricing page is almost always a NEW stranger,
    // not a returning user — send them to REGISTER (which stashes ?plan as
    // nbd_plan_intent and, post-signup, routes to checkout), not the login
    // wall they'd have no account for. Returning users use register's prominent
    // "Sign in here" link; the intent register.js stashed survives the
    // register→login→pricing bounce in sessionStorage, so their checkout still
    // resumes. Only pass a validated plan into the URL.
    const safePlan = (plan === 'starter' || plan === 'team' || plan === 'growth') ? plan : '';
    if (confirm('Create your account to continue to checkout?')) {
      window.location.href = '/pro/register.html' + (safePlan ? '?plan=' + safePlan : '');
    }
    return;
  }

  // Get ID token
  try {
    if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }

    const idToken = await user.getIdToken();
    const response = await fetch(getFunctionsBase() + '/createCheckoutSession', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken
      },
      body: JSON.stringify({ plan: plan })
    });

    const data = await response.json();

    if (data.url) {
      // Redirect to Stripe Checkout
      window.location.href = data.url;
    } else if (data.error === 'already_subscribed') {
      // Server-side double-bill guard (409): this company already holds a
      // live Stripe sub — plan changes go through the portal via the
      // dashboard Billing tab, never a second Checkout. Reached mainly by a
      // stale plan-intent auto-resume; the intent was already cleared above,
      // so this won't re-fire on the next visit.
      // DELIBERATELY a blocking alert, not a toast: the very next line
      // navigates to the dashboard, and a toast would be destroyed by that
      // navigation before it could be read. The signer of this message needs
      // to know where plan changes live. Keep it blocking until the redirect
      // is reworked to wait.
      alert(data.message || 'This company already has an active subscription. Manage or change your plan from Dashboard → Settings → Billing.');
      window.location.href = '/pro/dashboard.html';
    } else {
      _ppNotify(data.error || 'Could not create checkout session. Try again.', 'error');
      if (btn) { btn.textContent = originalLabel || 'Subscribe'; btn.disabled = false; }
    }
  } catch (e) {
    console.error('Checkout error:', e);
    _ppNotify('Connection error. Please try again.', 'error');
    if (btn) { btn.textContent = originalLabel || 'Subscribe'; btn.disabled = false; }
  }
};

// CSP-safe data-pr-action delegate. Prod `script-src-attr 'none'` blocks
// inline event-handler attributes silently; addEventListener is unaffected.
document.addEventListener('click', function(e) {
  const t = e.target.closest('[data-pr-action]');
  if (!t) return;
  const action = t.getAttribute('data-pr-action');
  if (action === 'subscribe') {
    e.preventDefault();
    window.subscribe(t.getAttribute('data-plan'), { target: t });
  } else if (action === 'faq-toggle') {
    // a11y: the action now lives on the <button class="faq-q"> (keyboard
    // operable); the .open class still drives the CSS on the parent item.
    const item = t.closest('.faq-item');
    if (!item) return;
    const open = item.classList.toggle('open');
    t.setAttribute('aria-expanded', String(open));
  }
});

// Update buttons based on auth state
let planIntentResumed = false;
onAuthStateChanged(auth, function(user) {
  document.querySelectorAll('.cta-primary').forEach(function(btn) {
    if (user) {
      btn.style.opacity = '1';
    } else {
      // Still allow clicking — subscribe() will redirect to login
    }
  });

  // Resume a checkout the visitor asked for before they had an account: the
  // plan they clicked on landing/register travels here via sessionStorage
  // (set by pages/register.js, routed via onboarding.js). One shot — the key
  // is cleared before launching so a failed checkout doesn't loop.
  if (!user || planIntentResumed) return;
  let plan = null;
  try {
    plan = sessionStorage.getItem('nbd_plan_intent');
    if (plan) sessionStorage.removeItem('nbd_plan_intent');
  } catch (_) {}
  if (plan !== 'starter' && plan !== 'team' && plan !== 'growth') {
    // No pending checkout to resume. Recover the pay-before-onboarding
    // reorder's one gap: a new owner routed here to pay who then CANCELS at
    // Stripe (cancel_url ?cancelled=true) would otherwise sit un-onboarded
    // (no brand / no reserved doc prefix), since the wizard now runs after
    // checkout. Send an un-onboarded owner to finish setup so they're never
    // worse off than the pre-reorder flow. Best-effort; onboarding self-heals
    // a missing company. Only on the cancel return — never interrupts a user
    // who navigated to pricing deliberately.
    if (checkoutCancelled) {
      getDoc(doc(db, 'users', user.uid)).then((snap) => {
        if (snap.exists() && snap.data().onboarded === false) {
          window.location.replace('/pro/onboarding.html');
        }
      }).catch(() => { /* leave them on pricing */ });
    }
    return;
  }
  planIntentResumed = true;
  const btn = document.querySelector('[data-pr-action="subscribe"][data-plan="' + plan + '"]');
  window.subscribe(plan, btn ? { target: btn } : undefined);
});
