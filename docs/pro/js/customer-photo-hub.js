/**
 * customer-photo-hub.js — the embedded per-customer photo sub-system.
 *
 * RoofLink-style editor rebuild, Phase 1d (2026-07-27). Sibling of
 * customer-estimate-hub.js; same "mini page, not a page" contract.
 *
 * THE PROBLEM (user-reported, same class as the ESTIMATE button): the PHOTOS
 * quick action inside a customer closed the job-detail overlay and navigated
 * to the GENERIC photos view — every photo in the tenant, customer context
 * gone. It set `window._currentPhotoLeadId` on the way out, but that global is
 * a weak handoff: the rep has still left the customer's record.
 *
 * Meanwhile the overlay ALREADY had a Photos tab, and it was a dead grid —
 * `<img>` tiles with no click handler, no way to add a photo, no way to act on
 * one. You could look at thumbnails and nothing else.
 *
 * THE FIX: mount a real photo workspace INSIDE that tab.
 *   window.CustomerPhotoHub.mount(containerOrId, leadId, opts)
 *
 * What it renders (all one scroll, customer header stays above):
 *   1. Strip        — photo count, tagged count, most recent capture.
 *   2. Capture row  — 📷 Take photo (PhotoEngine camera) and ⬆ Upload
 *                     (multi-file), both landing on THIS lead.
 *   3. Tag filter   — chips built from the tags actually present.
 *   4. Date groups  — CompanyCam-style, tiles now TAPPABLE.
 *   5. Photo detail — expands INLINE under the grid: full image, description,
 *                     tag toggles, and ★ Set cover / 🗑 Delete / ⤓ Open.
 *
 * Data: renders from window._photoCache[leadId] (filled on demand by
 * js/photo-cache.js since 2026-10-04 — no longer at boot — and
 * team-scoped — own + companyId). Mutations update that cache in place rather
 * than re-querying, so the overlay hero, the kanban card thumb strip and this
 * panel can never disagree. PhotoEngine.getPhotosForLead is deliberately NOT
 * used as a refresh: it queries userId-only, so it would NARROW a team
 * member's view, and it memoizes in its own cache.
 *
 * Cover writes mirror customer-tasks-ui.js setCoverPhotoFromPopup exactly:
 * flat coverPhotoId + denormalized coverPhotoUrl on the lead, toggle-to-clear.
 *
 * CSP: zero inline handlers. One delegated listener keyed on data-cph-act;
 * every interpolated value escaped.
 */
(function () {
  'use strict';
  if (window.CustomerPhotoHub && window.CustomerPhotoHub.__sentinel === 'nbd-cph-v1') return;

  // ── Helpers ──────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Photo URLs are Firebase download links, but they arrive from user-writable
  // docs — refuse anything that isn't http(s) so a javascript: value can never
  // reach an href or src.
  function safeUrl(u) {
    var s = String(u == null ? '' : u);
    return /^https?:\/\//i.test(s) ? s : '';
  }
  function ms(v) {
    if (!v) return 0;
    try {
      if (v.toDate) return v.toDate().getTime() || 0;
      if (v instanceof Date) return v.getTime() || 0;
      var t = new Date(v).getTime();
      return isFinite(t) ? t : 0;
    } catch (e) { return 0; }
  }
  // Mirrors the date resolution the old inline grid used: takenAt, then
  // createdAt, then uploadedAt — plus capturedAt as a final fallback.
  //
  // capturedAt is LAST on purpose. For a photo read back from Firestore,
  // createdAt is resolved and is the ordering authority (the /photos queries
  // orderBy it, with matching composite indexes) — this must not change that.
  // But a photo object we just pushed into the local cache after an upload
  // carries UNRESOLVED serverTimestamp() sentinels for createdAt/uploadedAt:
  // ms() cannot read them, returns 0, and the just-uploaded photo sorted to the
  // very bottom of the grid under an "Older" heading — below months-old shots,
  // with the "Latest" stat reading "—" if they were the customer's first. It
  // looked like a half-failed upload and reps re-shot the roof. capturedAt is
  // the one real epoch on that object, so it fills the gap until the doc is
  // re-read, and never overrides a resolved createdAt.
  function photoTime(p) {
    return ms(p && p.takenAt) || ms(p && p.createdAt) || ms(p && p.uploadedAt) || ms(p && p.capturedAt) || 0;
  }
  function dayLabel(t) {
    if (!t) return 'Older';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function photoUrl(p) {
    return safeUrl((p && (p.url || p.downloadUrl || p.src)) || '');
  }
  function thumbUrl(p) {
    return safeUrl((p && (p.thumbUrl || p.url || p.downloadUrl || p.src)) || '');
  }
  function toast(m, k) {
    if (typeof window.showToast === 'function') window.showToast(m, k || 'info');
  }
  function prettyTag(t) {
    return String(t || '').replace(/_/g, ' ');
  }

  // ── State ────────────────────────────────────────────────────────────
  var _root = null;
  var _leadId = null;
  var _opts = {};
  var _openPhotoId = null;
  var _filterTag = '';
  var _busy = false;
  var _clickBound = false;
  var _fileInput = null;

  function getLead() {
    var arr = window._leads || [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === _leadId) return arr[i];
    return (window._currentLead && window._currentLead.id === _leadId) ? window._currentLead : {};
  }
  function bag() {
    if (!window._photoCache) window._photoCache = {};
    if (!Array.isArray(window._photoCache[_leadId])) window._photoCache[_leadId] = [];
    return window._photoCache[_leadId];
  }
  function getPhotos() {
    return bag().slice().sort(function (a, b) { return photoTime(b) - photoTime(a); });
  }

  // ── Styles ───────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById('nbd-cph-style')) return;
    var st = document.createElement('style');
    st.id = 'nbd-cph-style';
    st.textContent = [
      '.cph{display:flex;flex-direction:column;gap:14px;}',
      '.cph-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}',
      '.cph-stat{background:var(--s2,#181c22);border:1px solid var(--br,#2a2f37);border-radius:10px;padding:10px 8px;text-align:center;min-width:0;}',
      '.cph-stat-v{font-family:\'Barlow Condensed\',sans-serif;font-size:20px;font-weight:800;color:var(--t,#eee);line-height:1.1;overflow:hidden;text-overflow:ellipsis;}',
      '.cph-stat-k{font-family:\'Barlow Condensed\',sans-serif;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--m,#98a0ab);margin-top:2px;}',
      '.cph-cap{display:flex;gap:8px;}',
      '.cph-cap .cph-btn{flex:1;}',
      '.cph-btn{padding:12px 8px;border-radius:9px;border:1px solid var(--br,#2a2f37);background:var(--s,#14181f);color:var(--t,#eee);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;-webkit-tap-highlight-color:transparent;}',
      '.cph-btn:active{background:color-mix(in srgb, var(--orange,#BD5728) 14%, transparent);}',
      '.cph-btn.primary{background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);color:var(--accent-fg,#fff);}',
      '.cph-btn.danger{color:var(--red,#e5484d);}',
      '.cph-btn[disabled]{opacity:.45;cursor:not-allowed;}',
      '.cph-filters{display:flex;flex-wrap:wrap;gap:5px;}',
      '.cph-fchip{padding:5px 10px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--br,#2a2f37);background:transparent;color:var(--m,#98a0ab);cursor:pointer;-webkit-tap-highlight-color:transparent;}',
      '.cph-fchip.on{color:var(--orange,#BD5728);border-color:var(--orange,#BD5728);background:color-mix(in srgb, var(--orange,#BD5728) 12%, transparent);}',
      '.cph-group{margin-bottom:4px;}',
      '.cph-date{font-family:\'Barlow Condensed\',sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--m,#98a0ab);margin-bottom:6px;}',
      '.cph-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;}',
      '.cph-tile{position:relative;padding:0;border:none;background:var(--s2,#181c22);border-radius:6px;overflow:hidden;cursor:pointer;aspect-ratio:1;-webkit-tap-highlight-color:transparent;}',
      '.cph-tile img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.cph-tile.on{outline:2px solid var(--orange,#BD5728);outline-offset:-2px;}',
      '.cph-tile-star{position:absolute;top:3px;left:4px;font-size:12px;text-shadow:0 1px 3px rgba(0,0,0,.8);}',
      '.cph-detail{background:var(--s2,#181c22);border:1px solid var(--orange,#BD5728);border-radius:10px;overflow:hidden;margin-top:8px;}',
      '.cph-detail img{width:100%;display:block;background:#000;max-height:52vh;object-fit:contain;}',
      '.cph-detail-bd{padding:12px 14px;}',
      '.cph-desc{font-size:13px;color:var(--t,#eee);margin-bottom:8px;word-break:break-word;}',
      '.cph-desc.empty{color:var(--m,#98a0ab);font-style:italic;}',
      '.cph-meta{font-size:11px;color:var(--m,#98a0ab);margin-bottom:10px;}',
      '.cph-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;}',
      '.cph-tag{padding:4px 9px;border-radius:20px;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border:1px solid var(--br,#2a2f37);background:transparent;color:var(--m,#98a0ab);cursor:pointer;-webkit-tap-highlight-color:transparent;}',
      '.cph-tag.on{color:var(--green,#2ecc8a);border-color:var(--green,#2ecc8a);background:color-mix(in srgb, var(--green,#2ecc8a) 12%, transparent);}',
      '.cph-acts{display:flex;flex-wrap:wrap;gap:6px;}',
      '.cph-acts .cph-btn{flex:1 1 auto;min-width:88px;font-size:12px;padding:10px 8px;}',
      '.cph-empty{padding:26px 14px;text-align:center;color:var(--m,#98a0ab);font-size:13px;}'
    ].join('');
    document.head.appendChild(st);
  }

  // The tag vocabulary the rep can toggle from here. Deliberately the SHORT
  // list — photo-engine.js owns the full taxonomy (3 categories, ~30 tags);
  // surfacing all of it in a phone panel would bury the actions. These are the
  // ones that drive downstream behavior: phase drives share-gallery bucketing,
  // damage/overview drive report selection.
  var QUICK_TAGS = ['before', 'during', 'after', 'damage_close_up', 'overview', 'measurement'];

  // ── Render ───────────────────────────────────────────────────────────
  function render() {
    if (!_root) return;
    var lead = getLead();
    var all = getPhotos();
    var photos = _filterTag
      ? all.filter(function (p) { return Array.isArray(p.tags) && p.tags.indexOf(_filterTag) !== -1; })
      : all;

    var tagged = all.filter(function (p) { return Array.isArray(p.tags) && p.tags.length; }).length;
    var latest = all.length ? photoTime(all[0]) : 0;

    var html = '<div class="cph">';

    // 1. Strip
    html += '<div class="cph-strip">' +
      '<div class="cph-stat"><div class="cph-stat-v">' + all.length + '</div><div class="cph-stat-k">Photos</div></div>' +
      '<div class="cph-stat"><div class="cph-stat-v">' + tagged + '</div><div class="cph-stat-k">Tagged</div></div>' +
      '<div class="cph-stat"><div class="cph-stat-v" style="font-size:14px;">' + esc(latest ? dayLabel(latest) : '—') + '</div><div class="cph-stat-k">Latest</div></div>' +
      '</div>';

    // 2. Capture row — both land on THIS lead, no navigation.
    html += '<div class="cph-cap">' +
      '<button type="button" class="cph-btn primary" data-cph-act="camera"' + (_busy ? ' disabled' : '') + '>📷 Take photo</button>' +
      '<button type="button" class="cph-btn" data-cph-act="upload"' + (_busy ? ' disabled' : '') + '>⬆ ' + (_busy ? 'Uploading…' : 'Upload') + '</button>' +
      '</div>';

    // 3. Tag filters — only tags actually present, so the row can't lie.
    var present = {};
    all.forEach(function (p) {
      (Array.isArray(p.tags) ? p.tags : []).forEach(function (t) { if (t) present[t] = (present[t] || 0) + 1; });
    });
    var tagKeys = Object.keys(present).sort();
    if (tagKeys.length) {
      html += '<div class="cph-filters">' +
        '<button type="button" class="cph-fchip' + (_filterTag ? '' : ' on') + '" data-cph-act="filter" data-cph-tag="">All ' + all.length + '</button>' +
        tagKeys.map(function (t) {
          return '<button type="button" class="cph-fchip' + (_filterTag === t ? ' on' : '') + '" data-cph-act="filter" data-cph-tag="' + esc(t) + '">' +
            esc(prettyTag(t)) + ' ' + present[t] + '</button>';
        }).join('') + '</div>';
    }

    // 4. Date-grouped grid
    if (!photos.length) {
      html += '<div class="cph-empty">' +
        (all.length ? 'No photos with that tag.' : 'No photos for this customer yet.<br>Take or upload one above — it attaches to this job automatically.') +
        '</div>';
    } else {
      var groups = [];
      var byDay = {};
      photos.forEach(function (p) {
        var k = dayLabel(photoTime(p));
        if (!byDay[k]) { byDay[k] = []; groups.push(k); }
        byDay[k].push(p);
      });
      html += groups.map(function (k) {
        return '<div class="cph-group"><div class="cph-date">' + esc(k) + '</div><div class="cph-grid">' +
          byDay[k].map(function (p) {
            var u = thumbUrl(p);
            var isCover = lead.coverPhotoId && p.id === lead.coverPhotoId;
            return '<button type="button" class="cph-tile' + (_openPhotoId === p.id ? ' on' : '') + '" data-cph-act="open" data-cph-id="' + esc(p.id) + '" aria-label="Photo">' +
              (u ? '<img loading="lazy" src="' + esc(u) + '" alt="">' : '') +
              (isCover ? '<span class="cph-tile-star">★</span>' : '') +
              '</button>';
          }).join('') + '</div></div>';
      }).join('');
    }

    // 5. Inline detail for the open photo — under the grid, not a modal, so
    //    the customer header is still one scroll away.
    if (_openPhotoId) {
      var sel = null;
      for (var i = 0; i < all.length; i++) if (all[i].id === _openPhotoId) sel = all[i];
      if (!sel) { _openPhotoId = null; }
      else {
        var full = photoUrl(sel);
        var isCover = lead.coverPhotoId === sel.id;
        var selTags = Array.isArray(sel.tags) ? sel.tags : [];
        html += '<div class="cph-detail">' +
          (full ? '<img src="' + esc(full) + '" alt="">' : '') +
          '<div class="cph-detail-bd">' +
            '<div class="cph-desc' + (sel.description ? '' : ' empty') + '">' +
              esc(sel.description || 'No description') + '</div>' +
            '<div class="cph-meta">' + esc(dayLabel(photoTime(sel))) +
              (sel.quality ? ' · ' + esc(sel.quality) : '') + '</div>' +
            '<div class="cph-tags">' +
              QUICK_TAGS.map(function (t) {
                var on = selTags.indexOf(t) !== -1;
                return '<button type="button" class="cph-tag' + (on ? ' on' : '') + '" data-cph-act="tag" data-cph-id="' + esc(sel.id) + '" data-cph-tag="' + esc(t) + '">' +
                  (on ? '✓ ' : '') + esc(prettyTag(t)) + '</button>';
              }).join('') +
            '</div>' +
            '<div class="cph-acts">' +
              '<button type="button" class="cph-btn' + (isCover ? '' : ' primary') + '" data-cph-act="cover" data-cph-id="' + esc(sel.id) + '">' +
                (isCover ? '★ Cover — tap to clear' : '☆ Set as cover') + '</button>' +
              (full ? '<a class="cph-btn" style="text-align:center;text-decoration:none;display:block;" href="' + esc(full) + '" target="_blank" rel="noopener noreferrer">⤓ Open</a>' : '') +
              '<button type="button" class="cph-btn danger" data-cph-act="delete" data-cph-id="' + esc(sel.id) + '">🗑 Delete</button>' +
              '<button type="button" class="cph-btn" data-cph-act="close">Close</button>' +
            '</div>' +
          '</div></div>';
      }
    }

    html += '</div>';
    _root.innerHTML = html;
  }

  // ── Cache + host sync ────────────────────────────────────────────────
  // Every mutation goes through here so the panel, the overlay hero, the
  // kanban thumb strip and window._photoCache can never drift apart.
  function syncHost() {
    render();
    if (typeof _opts.onPhotosChanged === 'function') {
      try { _opts.onPhotosChanged(_leadId, bag()); } catch (e) {}
    }
    if (typeof window.renderLeads === 'function' && Array.isArray(window._leads)) {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (e) {}
    }
  }

  // window.PhotoEngine is NOT a reliable "engine is ready" signal.
  // dashboard-actions.js installs a placeholder — `{ __nbdLazyPhotosStub: true }`
  // with method shims — precisely to mean "not loaded yet". Testing bare
  // truthiness accepted that placeholder as the engine, so loadBundle('photos')
  // never ran and the real engine never arrived. Everything downstream then
  // failed in a different way:
  //   - the stub's shims return undefined (they fire-and-forget), so the
  //     upload chain called .then() on undefined and threw BEFORE its .catch
  //     was attached — rejecting the whole chain, dropping files 2..N, and
  //     skipping the terminal handler that clears _busy, so the button sat on
  //     "⬆ Uploading…" forever;
  //   - the stub carries no deletePhoto/updatePhotoTags at all, so Delete and
  //     the tag chips fell through to "still loading" permanently — the load
  //     that would have fixed them was exactly what ensureEngine skipped.
  // Same check the sibling estimate hub already makes (customer-estimate-hub.js
  // withEstimates); this is that pattern applied here.
  function engineReady() {
    var pe = window.PhotoEngine;
    return !!(pe && !pe.__nbdLazyPhotosStub);
  }
  function ensureEngine() {
    if (engineReady()) return Promise.resolve(true);
    if (!(window.ScriptLoader && window.ScriptLoader.loadBundle)) return Promise.resolve(false);
    return window.ScriptLoader.loadBundle('photos').then(function () { return engineReady(); });
  }

  // ── Actions ──────────────────────────────────────────────────────────
  function doCamera() {
    ensureEngine().then(function (ok) {
      if (!ok || typeof window.PhotoEngine.openCamera !== 'function') {
        toast('Camera is still loading — try again in a moment', 'warning');
        return;
      }
      // The engine owns capture + staging + upload; it writes into the same
      // photos collection this panel reads. Refresh on return.
      try { window.PhotoEngine.openCamera(_leadId); } catch (e) {
        console.warn('[cph] camera failed:', e && e.message);
        toast('Could not open the camera', 'error');
      }
    });
  }

  function doUpload() {
    if (_busy) return;
    if (!_fileInput) {
      _fileInput = document.createElement('input');
      _fileInput.type = 'file';
      _fileInput.accept = 'image/*';
      _fileInput.multiple = true;
      _fileInput.style.display = 'none';
      _fileInput.addEventListener('change', onFilesPicked);
      document.body.appendChild(_fileInput);
    }
    _fileInput.value = '';
    _fileInput.click();
  }

  function onFilesPicked(ev) {
    var files = Array.prototype.slice.call((ev.target && ev.target.files) || []);
    if (!files.length) return;
    ensureEngine().then(function (ok) {
      if (!ok || typeof window.PhotoEngine.uploadFromFile !== 'function') {
        toast('Photo uploader is still loading — try again in a moment', 'warning');
        return;
      }
      _busy = true;
      render();
      var done = 0, failed = 0;
      // Pin the lead for the whole batch. _leadId is module-scoped and the per
      // file .then bodies run LATER — they used to read whatever it happened to
      // be at execution time. A rep who starts a 6-photo upload on LTE, backs
      // out, and opens another customer had the remaining files written under
      // the NEW lead's id: wrong Storage path, wrong Firestore doc, no signal.
      // The first customer's roof photos simply end up on someone else's job.
      var batchLead = _leadId;
      if (!batchLead) { _busy = false; render(); toast('No customer selected', 'error'); return; }
      // Sequential, not parallel: phone uploads on LTE fall over when several
      // multi-MB blobs contend, and the rep gets a clearer count this way.
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          // Promise.resolve() so a non-promise return can never throw before
          // the .catch below is attached — that failure mode is what rejected
          // the whole chain and left the button stuck on "Uploading…".
          return Promise.resolve(window.PhotoEngine.uploadFromFile(batchLead, f, [], ''))
            .then(function (photo) {
              if (photo && photo.id) {
                // Cache under the lead the file was uploaded FOR, not the one
                // on screen now — bag() reads the live _leadId.
                // Dedupe by id: the engine now seeds this same cache on a
                // successful write (so camera captures appear too), and this
                // path goes through the engine.
                if (!window._photoCache) window._photoCache = {};
                if (!Array.isArray(window._photoCache[batchLead])) window._photoCache[batchLead] = [];
                var _b = window._photoCache[batchLead];
                if (!_b.some(function (p) { return p && p.id === photo.id; })) _b.push(photo);
                done++;
              }
            })
            .catch(function (e) {
              failed++;
              console.warn('[cph] upload failed:', e && e.message);
            });
        });
      });
      chain.then(function () {
        _busy = false;
        // If the rep navigated to a different customer mid-batch, the upload
        // still completed correctly against batchLead — but repainting this
        // panel (now showing someone else) with that result would be wrong,
        // and the toast would name the wrong job.
        if (_leadId !== batchLead) return;
        syncHost();
        if (done) toast(done + ' photo' + (done === 1 ? '' : 's') + ' added' + (failed ? ' · ' + failed + ' failed' : ''), failed ? 'warning' : 'success');
        else toast('Upload failed', 'error');
      });
    });
  }

  function doDelete(id) {
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
    Promise.resolve(ask('Delete this photo? This cannot be undone.')).then(function (ok) {
      if (!ok) return;
      return ensureEngine().then(function (ready) {
        if (!ready || typeof window.PhotoEngine.deletePhoto !== 'function') {
          toast('Photo tools are still loading — try again in a moment', 'warning');
          return;
        }
        return window.PhotoEngine.deletePhoto(id).then(function () {
          var arr = bag();
          for (var i = arr.length - 1; i >= 0; i--) if (arr[i] && arr[i].id === id) arr.splice(i, 1);
          if (_openPhotoId === id) _openPhotoId = null;
          // A deleted photo must not stay the lead's cover.
          var lead = getLead();
          if (lead && lead.coverPhotoId === id) clearCover(lead);
          syncHost();
          toast('Photo deleted', 'success');
        });
      });
    }).catch(function (e) {
      console.error('[cph] delete failed:', e);
      toast('Could not delete the photo', 'error');
    });
  }

  function writeLead(patch) {
    if (!(window.db && window.doc && window.updateDoc)) return Promise.reject(new Error('not connected'));
    return window.updateDoc(window.doc(window.db, 'leads', _leadId), patch);
  }

  function applyLeadLocal(patch) {
    var arr = window._leads || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === _leadId) Object.assign(arr[i], patch);
    }
    if (window._currentLead && window._currentLead.id === _leadId) Object.assign(window._currentLead, patch);
  }

  function clearCover(lead) {
    var patch = { coverPhotoId: null, coverPhotoUrl: null };
    applyLeadLocal(patch);
    writeLead(patch).catch(function (e) { console.warn('[cph] cover clear failed:', e && e.message); });
    if (typeof _opts.onCoverChanged === 'function') { try { _opts.onCoverChanged(_leadId, null); } catch (e) {} }
  }

  // Toggle-to-clear, matching customer-tasks-ui.js setCoverPhotoFromPopup.
  // Persist BOTH the id and the denormalized url — every consumer (customer
  // hero, mobile job-detail hero, kanban thumb strip) reads coverPhotoUrl.
  function doCover(id) {
    var lead = getLead();
    var arr = bag();
    var photo = null;
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) photo = arr[i];
    if (!photo) return;
    var isCover = lead.coverPhotoId === id;
    var url = photoUrl(photo);
    if (!isCover && !url) { toast('That photo has no usable image URL', 'error'); return; }
    var patch = isCover
      ? { coverPhotoId: null, coverPhotoUrl: null }
      : { coverPhotoId: id, coverPhotoUrl: url };
    applyLeadLocal(patch);
    render();
    if (typeof _opts.onCoverChanged === 'function') {
      try { _opts.onCoverChanged(_leadId, patch.coverPhotoUrl); } catch (e) {}
    }
    if (typeof window.renderLeads === 'function' && Array.isArray(window._leads)) {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (e) {}
    }
    writeLead(patch).then(function () {
      toast(isCover ? 'Cover photo cleared' : 'Cover photo set ★', 'success');
    }).catch(function (e) {
      console.error('[cph] cover write failed:', e);
      toast('Could not save the cover photo', 'error');
    });
  }

  function doTag(id, tag) {
    var arr = bag();
    var photo = null;
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) photo = arr[i];
    if (!photo || !tag) return;
    var tags = Array.isArray(photo.tags) ? photo.tags.slice() : [];
    var at = tags.indexOf(tag);
    if (at === -1) tags.push(tag); else tags.splice(at, 1);
    // Optimistic — the panel repaints instantly; a failed write reverts.
    var prev = photo.tags;
    photo.tags = tags;
    render();
    ensureEngine().then(function (ok) {
      if (!ok || typeof window.PhotoEngine.updatePhotoTags !== 'function') {
        photo.tags = prev; render();
        toast('Photo tools are still loading — try again in a moment', 'warning');
        return;
      }
      return window.PhotoEngine.updatePhotoTags(id, tags).catch(function (e) {
        photo.tags = prev; render();
        console.warn('[cph] tag write failed:', e && e.message);
        toast('Could not save the tag', 'error');
      });
    });
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-cph-act]');
    if (!t || !_root.contains(t)) return;
    var act = t.getAttribute('data-cph-act');
    var id = t.getAttribute('data-cph-id');
    var tag = t.getAttribute('data-cph-tag');
    ev.preventDefault();
    ev.stopPropagation();
    switch (act) {
      case 'open':
        _openPhotoId = (_openPhotoId === id) ? null : id;
        render();
        break;
      case 'close':  _openPhotoId = null; render(); break;
      case 'filter': _filterTag = tag || ''; render(); break;
      case 'camera': doCamera(); break;
      case 'upload': doUpload(); break;
      case 'cover':  doCover(id); break;
      case 'tag':    doTag(id, tag); break;
      case 'delete': doDelete(id); break;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────
  function mount(containerOrId, leadId, opts) {
    var el = typeof containerOrId === 'string' ? document.getElementById(containerOrId) : containerOrId;
    if (!el || !leadId) return false;
    ensureStyle();
    if (_leadId !== leadId) { _openPhotoId = null; _filterTag = ''; }
    _root = el;
    _leadId = leadId;
    _opts = opts || {};
    _busy = false;
    if (!_clickBound) {
      document.addEventListener('click', function (ev) {
        if (!_root || !_root.isConnected) return;
        if (!_root.contains(ev.target)) return;
        onClick(ev);
      }, true);
      _clickBound = true;
      // Photos load on demand (js/photo-cache.js, 2026-10-04): repaint when
      // this lead's bag arrives after the tab is already showing.
      window.addEventListener('nbd:photos-loaded', function (ev) {
        var ids = (ev && ev.detail && ev.detail.leadIds) || [];
        if (_leadId && ids.indexOf(_leadId) !== -1) refresh();
      });
    }
    render();
    var pc = window.NBDPhotoCache;
    if (pc && typeof pc.ensure === 'function' && !pc.isLoaded(leadId)) pc.ensure([leadId]);
    return true;
  }

  function refresh() {
    if (!_root || !_root.isConnected || !_leadId) return;
    render();
  }

  function unmount() {
    if (_root) _root.innerHTML = '';
    _root = null;
    _leadId = null;
    _opts = {};
    _openPhotoId = null;
    _filterTag = '';
  }

  window.CustomerPhotoHub = {
    __sentinel: 'nbd-cph-v1',
    mount: mount,
    refresh: refresh,
    unmount: unmount,
    isMounted: function () { return !!(_root && _root.isConnected); },
    leadId: function () { return _leadId; }
  };
})();
