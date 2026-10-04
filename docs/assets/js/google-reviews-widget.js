/**
 * Google Reviews widget — fetches cached reviews from the
 * getGoogleReviews Cloud Function and renders a rating summary plus
 * the latest 5 reviews into any element matching [data-nbd-google-reviews].
 *
 * Graceful degradation: if the endpoint is unavailable or returns no
 * data, the container renders a "Read our reviews on Google" card that
 * links straight to the profile (2026-07-12; it previously hid itself,
 * which left the page with a 5.0 claim and zero visible live reviews
 * whenever the API misbehaved).
 *
 * The rendered grid caps at 6 cards: the GBP-synced payload can carry
 * every review (dozens); this widget is the freshness layer and the
 * "See all on Google" chip carries the rest. Places payloads are ≤5,
 * so the cap is a no-op until the full-set sync is live.
 */
(function () {
  'use strict';

  const ENDPOINT = '/api/google-reviews';
  // Google Business Profile short link — the one hardcoded copy in this
  // file; the happy path uses data.profileUrl from the API instead.
  const PROFILE_URL = 'https://g.page/r/CXzIjLwvtRPdEBM';
  const STAR_FULL =
    '<svg viewBox="0 0 24 24" fill="#fbbc04" aria-hidden="true" width="16" height="16"><polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9"/></svg>';
  const STAR_EMPTY =
    '<svg viewBox="0 0 24 24" fill="#2d3748" aria-hidden="true" width="16" height="16"><polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9"/></svg>';
  // Google "G" mark, shared by the header pill and the fallback card.
  const GOOGLE_G = (size) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" width="${size}" height="${size}"><path fill="#4285f4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0 0 12 23z"/><path fill="#fbbc04" d="M5.84 14.09A6.6 6.6 0 0 1 5.48 12c0-.73.13-1.43.35-2.09V7.07H2.18A10.99 10.99 0 0 0 1 12c0 1.77.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>`;

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function stars(n) {
    const whole = Math.round(n || 0);
    let html = '';
    for (let i = 0; i < 5; i++) html += i < whole ? STAR_FULL : STAR_EMPTY;
    return `<span style="display:inline-flex;gap:2px;vertical-align:middle" role="img" aria-label="${whole} out of 5 stars">${html}</span>`;
  }

  // Review momentum — " · 4 new this month". The server attaches `recent`
  // only when Google's own review count has honestly grown against a real
  // baseline (functions/google-reviews-momentum.js); otherwise this returns
  // '' and nothing on the page changes. `days` is the real span: 28–31 reads
  // "this month", anything else says the number. Built only from integers,
  // so it is safe in innerHTML (cards header) and textContent (static hooks).
  function recentText(data) {
    const r = data && data.recent;
    if (!r || typeof r !== 'object') return '';
    const n = Number(r.newReviews);
    const days = Number(r.days);
    if (!Number.isInteger(n) || n < 1 || !Number.isInteger(days) || days < 1) return '';
    const when = days >= 28 && days <= 31 ? 'this month' : 'in the last ' + days + ' days';
    return ' · ' + n + ' new ' + when;
  }

  function truncate(text, limit) {
    const t = (text || '').trim();
    if (t.length <= limit) return esc(t);
    return esc(t.slice(0, limit).trim()) + '&hellip;';
  }

  function renderReviewCard(review) {
    const name = esc(review.author || 'Google user');
    const photo = review.profilePhotoUrl
      ? `<img src="${esc(review.profilePhotoUrl)}" alt="" referrerpolicy="no-referrer" class="gr-avatar" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0">`
      : `<div style="width:40px;height:40px;border-radius:50%;background:#e8e5e0;flex-shrink:0"></div>`;
    const when = esc(review.relativeTime || '');
    const text = truncate(review.text || '', 320);
    return `
      <div class="gr-card" style="background:#fff;border:1px solid #e8e5e0;border-radius:12px;padding:22px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          ${photo}
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;color:#12223d;font-size:.95rem">${name}</div>
            <div style="font-size:.78rem;color:#5d6673">${when}</div>
          </div>
          <div>${stars(review.rating)}</div>
        </div>
        <div style="font-size:.95rem;line-height:1.65;color:#4a4a4a">${text}</div>
      </div>`;
  }

  // Empty payload or fetch failure. The live layer's job is freshness;
  // when it can't deliver, the honest fallback is a direct pointer at the
  // profile — not display:none.
  function renderFallback(container) {
    container.innerHTML = `
      <div style="text-align:center">
        <a href="${PROFILE_URL}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:12px;background:#fff;border:1px solid #e8e5e0;border-radius:12px;padding:18px 28px;text-decoration:none">
          ${GOOGLE_G(26)}
          <span style="text-align:left">
            <span style="display:block;font-weight:800;color:#12223d;font-size:.95rem">Read our reviews on Google &rarr;</span>
            <span style="display:block;font-size:.78rem;color:#5d6673">Every review, straight from our profile.</span>
          </span>
        </a>
      </div>`;
  }

  function renderAll(container, data) {
    const rating = data.rating || 0;
    const total = data.total || 0;
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    const profileUrl = data.profileUrl || '';
    const staleBadge = data.stale
      ? '<span style="font-size:.7rem;color:#5d6673;margin-left:8px">(showing last-known reviews)</span>'
      : '';

    if (!reviews.length) {
      renderFallback(container);
      return;
    }

    container.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:24px">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;justify-content:center;text-align:center">
          <div style="display:inline-flex;align-items:center;gap:10px;background:#fff;border:1px solid #e8e5e0;border-radius:100px;padding:10px 20px">
            ${GOOGLE_G(22)}
            <div style="text-align:left">
              <div style="font-weight:800;color:#12223d;font-size:.95rem">Google Reviews</div>
              <div style="font-size:.78rem;color:#5d6673">Live from our profile${staleBadge}</div>
            </div>
          </div>
          <div style="display:inline-flex;align-items:center;gap:10px;background:#fff;border:1px solid #e8e5e0;border-radius:100px;padding:10px 20px">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:2.2rem;color:#12223d;line-height:1">${rating.toFixed(1)}</div>
            <div style="display:flex;flex-direction:column;gap:2px">
              <div>${stars(rating)}</div>
              <div style="font-size:.75rem;color:#5d6673">${total} review${total === 1 ? '' : 's'}${recentText(data)}</div>
            </div>
          </div>
          ${
            profileUrl
              ? `<a href="${esc(profileUrl)}" target="_blank" rel="noopener" style="font-size:.78rem;font-weight:700;color:#A14A22;background:#fff;border:1px solid #e8e5e0;border-radius:100px;padding:10px 16px;text-decoration:none;letter-spacing:.06em;text-transform:uppercase">See all on Google &rarr;</a>`
              : ''
          }
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
          ${reviews.slice(0, 6).map(renderReviewCard).join('')}
        </div>
      </div>`;
    // Hide avatars whose Google URL has expired/404s. Was an inline
    // onerror= attribute, but the global CSP's script-src-attr 'none'
    // refuses inline handlers even in JS-built markup (audit 2026-06-10) —
    // the broken-image icon showed instead. Listener must attach after the
    // innerHTML insertion; error events don't bubble, so per-element.
    container.querySelectorAll('img.gr-avatar').forEach((img) => {
      img.addEventListener('error', () => { img.style.display = 'none'; });
      // If the image already failed before this listener attached (cached
      // 404 resolves synchronously on some engines), catch it via complete.
      if (img.complete && img.naturalWidth === 0) img.style.display = 'none';
    });
  }

  // Hydrate any static rating/count hooks elsewhere on the page (e.g. the
  // /review hero score box, the homepage #reviews summary) from the same
  // payload. The hooks ship with static fallback text, so a failed fetch
  // simply leaves them untouched — last-known-true beats a zero.
  //
  // Five hooks, because the pages need different shapes of the same numbers:
  //   data-nbd-gr-rating  the score alone ("5.0")
  //   data-nbd-gr-total   the count alone ("29") — the page owns the wording
  //   data-nbd-gr-count   a whole ready-made sentence (/review's tap target)
  //   data-nbd-gr-stars   the star row, re-rendered from the live rating
  //   data-nbd-gr-recent  " · N new this month" — only when `recent` exists
  // The star row matters: a hardcoded ★★★★★ keeps claiming five stars after
  // the profile drops below 4.5, and nothing on the page would correct it.
  // stars() rounds exactly as the review cards do, so both agree.
  //
  // The star hook is the one innerHTML write here. It is safe by construction:
  // stars() emits only the two frozen SVG constants above plus Math.round() of
  // a number, so no API string ever reaches it — unlike the review text and
  // author names, which go through esc()/truncate(). Keep it that way.
  function hydrateStaticHooks(data) {
    const rating = data.rating || 0;
    const total = data.total || 0;
    if (!total) return;
    document.querySelectorAll('[data-nbd-gr-rating]').forEach((el) => {
      el.textContent = rating.toFixed(1);
    });
    document.querySelectorAll('[data-nbd-gr-total]').forEach((el) => {
      el.textContent = String(total);
    });
    document.querySelectorAll('[data-nbd-gr-count]').forEach((el) => {
      el.textContent = total + ' Google review' + (total === 1 ? '' : 's') + ' • tap to see them all';
    });
    document.querySelectorAll('[data-nbd-gr-stars]').forEach((el) => {
      el.innerHTML = stars(rating);
    });
    // data-nbd-gr-recent ships EMPTY: no momentum in the payload means the
    // hook is never touched, so the row renders exactly as before.
    const recent = recentText(data);
    if (recent) {
      document.querySelectorAll('[data-nbd-gr-recent]').forEach((el) => {
        el.textContent = recent;
      });
    }
  }

  // Last good payload, so hooks rendered AFTER the fetch (the quick form on
  // service/area pages builds its trust line in JS) can be hydrated too.
  let _lastData = null;
  window.nbdHydrateReviewHooks = function () { if (_lastData) hydrateStaticHooks(_lastData); };

  async function load() {
    const container = document.querySelector('[data-nbd-google-reviews]');
    // 2026-10-03: the trust line above every lead form's Submit carries a
    // data-nbd-gr-rating hook on pages with NO review cards (/estimate,
    // /storm-check, /storm-alerts, /inspect, the quick form). Hydrate those
    // too; with neither cards nor hooks there is nothing to fetch for.
    const hasHooks = !!document.querySelector('[data-nbd-gr-rating],[data-nbd-gr-total],[data-nbd-gr-count],[data-nbd-gr-stars]');
    if (!container && !hasHooks) return;

    if (container) {
      container.innerHTML =
        '<div style="text-align:center;padding:32px;color:#5d6673;font-size:.9rem">Loading Google reviews&hellip;</div>';
    }

    try {
      const res = await fetch(ENDPOINT, { credentials: 'omit' });
      if (!res.ok) throw new Error('bad_status:' + res.status);
      const data = await res.json();
      if (data && data.error) throw new Error(data.error);
      _lastData = data || {};
      hydrateStaticHooks(data || {});
      if (container) renderAll(container, data || {});
    } catch (err) {
      console.warn('[google-reviews] load failed:', err);
      if (container) renderFallback(container);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
