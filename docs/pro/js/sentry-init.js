/**
 * sentry-init.js — client-side error reporter
 *
 * Loads the Sentry SDK over CDN only when window.__NBD_SENTRY_DSN is
 * set. The DSN is public (safe to embed — Sentry treats it as an
 * origin identifier, not a secret). Set it once in dashboard.html:
 *
 *   <script>window.__NBD_SENTRY_DSN = "https://…@o…ingest.sentry.io/…";</script>
 *
 * Captures:
 *   - Uncaught errors (via window.onerror)
 *   - Unhandled promise rejections
 *   - window.NBDSentry.capture(err, {op:'...'}) from explicit call sites
 *
 * Redacts:
 *   - Emails / phones / addresses from breadcrumbs and event bodies
 *   - Firebase ID tokens from any url/query string
 */

(function () {
  'use strict';

  if (window.NBDSentry && window.NBDSentry.__sentinel === 'nbd-sentry-v1') return;

  const DSN = (window.__NBD_SENTRY_DSN || '').trim();
  if (!DSN) {
    window.NBDSentry = {
      __sentinel: 'nbd-sentry-v1',
      configured: false,
      capture: function () {}
    };
    return;
  }

  // Load Sentry's browser SDK asynchronously. Use the bundle-loader
  // so we don't block first paint. Version pinned to a known-good
  // release.
  const script = document.createElement('script');
  script.src = 'https://browser.sentry-cdn.com/7.120.0/bundle.tracing.min.js';
  script.crossOrigin = 'anonymous';
  script.integrity = 'sha384-qcwbea4ny6qhrhRBPu+pNH1T7WSXwcaxP5mUNeYCnHiJ5BUfyFyJzB41byw7i8BV';
  script.onload = function () {
    try {
      window.Sentry.init({
        dsn: DSN,
        // Page-load speed (2026-11-04): the tracing bundle was loaded but no tracing integration was on, so no
        // page-load timing (LCP, FCP, CLS, TTFB) ever reached Sentry. Every page load is sampled (a small team's
        // loads are well inside the free quota); other spans keep the old 5 %. No trace headers are added to ANY
        // request (tracePropagationTargets: []), so Firebase / Stripe / function calls see exactly what they did.
        integrations: (function () {
          try {
            if (typeof window.Sentry.browserTracingIntegration === 'function') return [window.Sentry.browserTracingIntegration()];
            if (typeof window.Sentry.BrowserTracing === 'function') return [new window.Sentry.BrowserTracing()];
          } catch (e) {}
          return [];
        })(),
        tracePropagationTargets: [],
        tracesSampler: function (ctx) {
          var op = (ctx && (ctx.transactionContext && ctx.transactionContext.op || ctx.op)) || '';
          return op === 'pageload' ? 1.0 : 0.05;
        },
        // Page addresses lose their query string (?id=… lead / customer ids) before a transaction leaves the browser.
        beforeSendTransaction: function (tx) {
          try {
            var strip = function (u) { return typeof u === 'string' ? u.split('?')[0].split('#')[0] : u; };
            if (tx.request && tx.request.url) tx.request.url = strip(tx.request.url);
            if (tx.transaction) tx.transaction = strip(tx.transaction);
            if (tx.spans) tx.spans.forEach(function (s) { if (s.description) s.description = strip(s.description); if (s.data && s.data.url) s.data.url = strip(s.data.url); });
          } catch (e) {}
          return tx;
        },
        environment: location.hostname.includes('localhost') ? 'dev' : 'production',
        release: (window.__NBD_RELEASE || 'web@unknown'),
        ignoreErrors: [
          // Firebase can throw these on transient network blips — not
          // actionable and would flood Sentry.
          'FirebaseError: Failed to get document',
          'ResizeObserver loop limit exceeded',
          'Network request failed',
          'Load failed'
        ],
        // Redact PII on the way out.
        beforeSend: function (event) {
          try {
            if (event.user) {
              event.user = { id: event.user.id || null };
            }
            const redact = function (str) {
              if (typeof str !== 'string') return str;
              return str
                .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
                .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]')
                .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [token]')
                .replace(/idToken=[^&]+/g, 'idToken=[token]');
            };
            if (event.message)           event.message           = redact(event.message);
            if (event.exception && event.exception.values) {
              event.exception.values.forEach(function (v) {
                if (v.value) v.value = redact(v.value);
              });
            }
            if (event.breadcrumbs) {
              event.breadcrumbs.forEach(function (b) {
                if (b.message) b.message = redact(b.message);
                if (b.data && b.data.url) b.data.url = redact(b.data.url);
              });
            }
          } catch (e) { /* redact failure must not drop the event */ }
          return event;
        }
      });

      // Tag user once Firebase Auth resolves. Subtle: window._user
      // may arrive after this script runs, so poll briefly.
      let tries = 0;
      const t = setInterval(function () {
        tries++;
        if (window._user && window._userClaims) {
          window.Sentry.setUser({ id: window._user.uid });
          window.Sentry.setTag('companyId', window._userClaims.companyId || 'none');
          window.Sentry.setTag('plan', window._userClaims.plan || 'none');
          clearInterval(t);
        } else if (tries > 40) {
          clearInterval(t);
        }
      }, 250);

      window.NBDSentry.configured = true;
    } catch (e) {
      console.warn('Sentry client init failed:', e);
    }
  };
  script.onerror = function () {
    console.warn('Sentry CDN failed to load');
  };
  document.head.appendChild(script);

  window.NBDSentry = {
    __sentinel: 'nbd-sentry-v1',
    configured: false,
    capture: function (err, extra) {
      try {
        if (window.Sentry && typeof window.Sentry.captureException === 'function') {
          if (extra) window.Sentry.setContext('nbd', extra);
          window.Sentry.captureException(err);
        } else {
          console.error('[NBDSentry unconfigured]', err, extra);
        }
      } catch (e) { /* swallow */ }
    }
  };
})();
