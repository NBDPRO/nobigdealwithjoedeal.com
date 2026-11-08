
          // Photo system Phase 4: route the Review link to the current lead.
          // Old approach was a render-time wire() that set the <a href> as
          // soon as window._customerId existed. That raced against the
          // auth-then-loadCustomerData chain: after the §perf defer pass
          // (PR #435), externals + module scripts load AFTER HTML parse,
          // so the customer ID is often still undefined when DCL fires
          // and even the 600ms fallback timer. Result: button stayed at
          // the placeholder ?lead= and the user landed on the empty-state
          // photo-review page.
          //
          // Robust fix: intercept the click and read window._customerId
          // AT CLICK TIME. The href stays a no-op placeholder; the click
          // handler navigates manually. No timing windows.
          (function () {
            var btn = document.getElementById('prReviewBtn');
            if (!btn) return;
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              var id = window._customerId;
              if (!id) {
                if (typeof window.showToast === 'function') {
                  window.showToast('Still loading the customer — try again in a moment.', 'error');
                } else {
                  console.warn('Customer still loading — try again in a moment.');
                }
                return;
              }
              window.location.href = (window.NBDUrl && window.NBDUrl.photoReview(id))
                || ('/pro/photo-review?id=' + encodeURIComponent(id));
            });
          })();
        