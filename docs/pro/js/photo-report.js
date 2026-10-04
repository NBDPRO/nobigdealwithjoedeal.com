/**
 * NBD Pro — Photo Report Generator
 * One-click before/after report that pulls actual photos from a lead
 * and generates a beautiful branded PDF-ready HTML document.
 *
 * Exposes: window.generatePhotoReport(leadId)
 */

(function() {
  'use strict';

  // Brand strings only. All visual styling (color/type/space) comes
  // from nbd-brand.css — the same locked token set that drives the
  // homeowner portal, share-link pages, and any other customer-facing
  // surface. Photo system Phase 1 (2026-05-13): every customer artifact
  // must come out of one brand source so the PDF a homeowner gets emailed
  // looks like the portal they were already shown.
  //
  // gauntlet Batch 3 — the CLIENT-side fallback report body (buildReportHTML,
  // rendered only when the server Puppeteer render fails) hardcoded NBD, so a
  // stranger tenant's fallback PDF still read "No Big Deal Home Solutions ·
  // (859) 420-7382". window._brand() (company-profile.js / TenantContext) now
  // drives name/phone/email/website/tagline so the fallback carries THAT
  // tenant's identity. NBD (no brand, or the canonical NBD legalName) resolves
  // to the exact literals below → the fallback renders BYTE-IDENTICAL for NBD.
  // Resolved via LAZY GETTERS (per access, all at render/user-action time)
  // because this IIFE can run before company-profile.js registers window._brand.
  // Mirrors customer-portal.js.
  function _brandRaw() {
    try { if (typeof window._brand === 'function') return window._brand() || {}; } catch (e) { /* fall through */ }
    return {};
  }
  function _isNbdBrand(b) { return !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions'; }
  const BRAND = {
    get name()    { const b = _brandRaw(); return _isNbdBrand(b) ? 'No Big Deal Home Solutions'    : (b.legalName || 'No Big Deal Home Solutions'); },
    // Non-NBD branch falls back to '' (NOT the NBD literal): _resolveBrand()
    // blanks an unset tenant contact field to '', so `|| NBD-literal` would
    // re-leak Joe's number/email/site onto a stranger's report. NBD unchanged.
    get phone()   { const b = _brandRaw(); return _isNbdBrand(b) ? '(859) 420-7382'                : ((b.contact && b.contact.phone)   || ''); },
    get email()   { const b = _brandRaw(); return _isNbdBrand(b) ? 'info@nobigdealwithjoedeal.com' : ((b.contact && b.contact.email)   || ''); },
    get website() { const b = _brandRaw(); return _isNbdBrand(b) ? 'nobigdealwithjoedeal.com'      : ((b.contact && b.contact.website) || ''); },
    // Footer seal tagline. NBD keeps Joe's slogan "We Put Our Name On It";
    // a stranger tenant gets their own tagline if set, else the seal drops.
    get tagline() { const b = _brandRaw(); return _isNbdBrand(b) ? 'We Put Our Name On It'          : (b.tagline || ''); }
  };

  /**
   * Generate a before/after photo report for a lead.
   *
   * Phase 5 Output Engine: same dataset → two PDF styles.
   *   mode='homeowner' (default) — visual story, friendly captions,
   *     before/after pairs prominent. The one you email a homeowner.
   *   mode='adjuster'  — dense, label-forward, technical captions
   *     showing location + damageType + severity per photo. The one
   *     you drop into an insurance supplement.
   *
   * @param {string} leadId
   * @param {('homeowner'|'adjuster')} [mode='homeowner']
   */

  /**
   * Display-order comparator for the photo report.
   *
   * Mirrors nbdComparePhotos (customer-bootstrap.module.js:1262) for the
   * `order` field — the integer persistCustomerPhotoOrder writes when a rep
   * drags photos in the gallery — so the PDF comes out in the sequence the rep
   * arranged. Photos WITH an order sort ahead of those without, as the gallery
   * does.
   *
   * It deliberately DIVERGES on the fallback DIRECTION: the gallery falls back
   * to uploadedAt DESCENDING; this keeps the report ASCENDING. Matching the
   * gallery there would silently re-order every existing report for leads
   * nobody has dragged — far bigger than the bug that motivated it.
   *
   * The fallback FIELD, though, is whatever the writer left, via
   * _photoTimestampMs — the same resolution _dateLabel prints. It used to read
   * `createdAt.seconds` and nothing else, which scored 0 for every photo the
   * customer page uploaded (it stamps date + uploadedAt), for every photo
   * photo-engine wrote before the createdAt cutover (capturedAt), and for any
   * createdAt arriving as a live Timestamp with toMillis() but no enumerable
   * `seconds`. All of them tied at 0 and came out in Firestore's return order.
   * Sorting on the field the caption already prints is also what stops a frame
   * dated "Aug 12" from landing after one dated "Aug 14" in the same PDF.
   *
   * Pure: no DOM, no Firebase. Exported as window._comparePhotoReportOrder.
   */
  function _comparePhotoReportOrder(a, b) {
    const ao = (a && typeof a.order === 'number') ? a.order : null;
    const bo = (b && typeof b.order === 'number') ? b.order : null;
    if (ao !== null && bo !== null) return ao - bo;
    if (ao !== null) return -1;
    if (bo !== null) return 1;
    return _photoTimestampMs(a) - _photoTimestampMs(b);
  }

  /**
   * Epoch milliseconds for a photo, from whichever timestamp the writer
   * happened to leave, or 0 when there is nothing usable.
   *
   * /photos is schema-less and its writers do not agree, so the field has to be
   * resolved rather than assumed — see _dateLabel for the roll-call. EXIF
   * takenAt leads because it is the truest "when was this taken"; `date` and
   * `uploadedAt` trail because they are write time, not capture time.
   *
   * The SHAPE varies independently of the field: a Firestore Timestamp read
   * back live has toMillis(), the same doc through JSON has a plain
   * {seconds,nanoseconds}, capturedAt is a raw epoch number, and EXIF dates
   * arrive as strings. Handling one shape and not the others is the same bug
   * as handling one field and not the others.
   *
   * Pure. Exported as window._photoReportTimestampMs for tests.
   */
  function _photoTimestampMs(p) {
    const raw = p && ((p.exif && p.exif.takenAt) || p.takenAt || p.capturedAt
      || p.date || p.createdAt || p.uploadedAt);
    if (!raw) return 0;
    let d;
    if (typeof raw.toMillis === 'function') d = new Date(raw.toMillis());
    else if (typeof raw.seconds === 'number') d = new Date(raw.seconds * 1000);
    // Duck-typed rather than `instanceof Date`: a Date that crossed a realm
    // boundary — an iframe, a worker, a vm sandbox in a test — fails the
    // instanceof and would silently score 0 and sort as undated.
    else if (typeof raw.getTime === 'function') d = raw;
    else if (typeof raw === 'number') d = new Date(raw);
    else if (typeof raw === 'string') d = new Date(raw);
    else return 0;
    const ms = d ? d.getTime() : NaN;
    return isNaN(ms) ? 0 : ms;
  }

  /**
   * @param {string} leadId
   * @param {('homeowner'|'adjuster')} [mode='homeowner']
   * @param {object} [build] D-6 report-builder input, all optional:
   *   { options:{…see REPORT_DEFAULTS…}, notes:{coverLetter,summaryBody,closing,
   *     sections:{before,during,after}}, sectionOrder:[], disabledSections:[],
   *     sectionTitles:{}, photoIds:[], coverPhotoUrl, coverEyebrow,
   *     coverTagline, coverSub, coverCaption }
   *   Omit it entirely and the report renders on this mode's defaults.
   */
  async function generatePhotoReport(leadId, mode, build) {
    leadId = leadId || window._customerId || window._cardDetailLeadId;
    if (!leadId || !window._user) {
      if (typeof showToast === 'function') showToast(!window._user ? 'Must be logged in' : 'No customer selected', 'error');
      return;
    }
    const reportMode = (mode === 'adjuster') ? 'adjuster' : 'homeowner';
    build = build || {};

    if (typeof showToast === 'function') showToast('Building ' + reportMode + ' photo report...', 'ok');

    try {
      // Get lead data
      const lead = (window._leads || []).find(l => l.id === leadId);
      if (!lead) throw new Error('Lead not found');

      // Load all photos for this lead
      let photos = [];
      try {
        // Team visibility. This queried leadId + userId directly, while the
        // gallery on the same page goes through _photoQueryScopes
        // (customer-bootstrap.module.js:1531), which drops the userId filter
        // for a company reader viewing a teammate's lead. So a manager who
        // could SEE every photo in the grid got zero rows here and was told
        // "No photos found for this lead — upload some first".
        //
        // Falls back to the owner-scoped pair when the helper is absent — it
        // is exported by the customer page's bootstrap, and this module also
        // runs on the dashboard, where `_currentLead` has no meaning anyway.
        const scopes = (typeof window._photoQueryScopes === 'function')
          ? window._photoQueryScopes(leadId)
          : [window.where('leadId', '==', leadId), window.where('userId', '==', window._user.uid)];
        const snap = await window.getDocs(window.query(
          window.collection(window.db, 'photos'),
          ...scopes
        ));
        photos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch (e) {
        // Distinguish a real failure from an empty lead. The caller's next
        // branch says "upload some first", which sends a rep down the wrong
        // path entirely when the truth was a rules denial or an offline client.
        console.warn('Photo load failed:', e && e.message);
        if (typeof showToast === 'function') {
          showToast('Could not load photos — ' + ((e && e.message) || 'try again'), 'error');
        }
        return;
      }

      if (photos.length === 0) {
        if (typeof showToast === 'function') showToast('No photos found for this lead — upload some first', 'error');
        return;
      }

      // Honour the rep's drag-rearranged gallery order.
      //
      // persistCustomerPhotoOrder (customer-bootstrap.module.js:1304) writes an
      // integer `order` onto each photos/{id} doc, and the gallery sorts by it
      // via nbdComparePhotos. This report ignored it and sorted by createdAt
      // alone, so the PDF a homeowner received came out in a DIFFERENT order
      // from the gallery the rep had just arranged. The field was already on
      // these objects — line 83 spreads the whole doc — merely unused.
      //
      // Ordered-before-unordered matches nbdComparePhotos exactly. The FALLBACK
      // deliberately does NOT: the gallery falls back to uploadedAt descending,
      // this keeps its own createdAt ascending. Adopting the gallery's fallback
      // would silently re-order every existing report for leads nobody has
      // dragged, which is a much larger change than the bug being fixed.
      photos.sort(_comparePhotoReportOrder);

      // ── D-6: explicit photo selection ──
      // Every entry point used to render EVERY photo on the lead. A rep who
      // wanted eight of forty had no way to say so.
      if (Array.isArray(build.photoIds) && build.photoIds.length) {
        const want = new Set(build.photoIds);
        const picked = photos.filter((p) => want.has(p.id));
        if (picked.length) photos = picked;
      }

      // ── D-6: honour sharedWithHomeowner on the homeowner report ──
      // functions/portal.js:479 gates the homeowner PORTAL gallery on
      // `sharedWithHomeowner == true`, with the reason written at :463 —
      // "homeowner doesn't need to see internal damage workups or photos
      // uploaded for a different lead by mistake". The homeowner photo REPORT,
      // a PDF emailed to that same homeowner, honoured no such flag and
      // printed everything on the lead.
      //
      // 'auto' rather than a hard gate on purpose. Most leads have never had
      // the flag flipped, and a hard gate would turn every one of those into an
      // empty report — trading a leak for a silent blank document. So: if the
      // rep has curated ANY photo on this lead, treat that as intent and honour
      // it; if nobody ever touched the flag, there is no curation to respect
      // and behaviour is unchanged. `true` and `false` force either way.
      const _sharedMode = _reportOptions(reportMode, build.options).sharedOnly;
      const _anyShared = photos.some((p) => p.sharedWithHomeowner === true);
      if (_sharedMode === true || (_sharedMode === 'auto' && reportMode === 'homeowner' && _anyShared)) {
        const shared = photos.filter((p) => p.sharedWithHomeowner === true);
        if (shared.length) photos = shared;
      }

      // Split into before/after using phase, tag, type, or category fields
      const getPhase = p => (p.phase || p.tag || p.type || p.category || '').toLowerCase();
      const beforePhotos = photos.filter(p => getPhase(p).includes('before'));
      const duringPhotos = photos.filter(p => getPhase(p).includes('during'));
      const afterPhotos = photos.filter(p => getPhase(p).includes('after'));

      let before, during, after;
      const hasPhases = beforePhotos.length > 0 || duringPhotos.length > 0 || afterPhotos.length > 0;
      if (hasPhases) {
        before = beforePhotos;
        during = duringPhotos;
        after = afterPhotos;
      } else {
        // No phase tags at all — show all as "Project Photos" (don't guess)
        before = photos;
        during = [];
        after = [];
      }

      const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || 'Homeowner';
      const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

      // ─── D-4: try server-side Puppeteer render first ───
      // The new template uses the shared cover + design system, with
      // mode-aware sections (homeowner = visual story, adjuster =
      // evidence dossier). The legacy buildReportHTML stays as a
      // fallback for any case the server rejects.
      try {
        const ok = await _tryServerRenderPhotoReport(Object.assign({
          lead, name, before, during, after,
          mode: reportMode,
          allPhotos: photos,
        }, build));
        if (ok) return;
      } catch (e) {
        console.warn('[photo-report] server render failed, falling back:', e && e.message || e);
      }

      const html = buildReportHTML(lead, name, before, during, after, now, hasPhases, reportMode);

      // Route through the Universal Document Viewer so the user
      // can Print or Download PDF via the action bar instead of
      // being dumped into a blank popup.
      if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
        const slug = (name || 'photos').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
        const modeTag = reportMode === 'adjuster' ? 'Adjuster' : 'Homeowner';
        // Tenant-resolved prefix — this filename reaches the homeowner. '' when
        // the brand is not hydrated, never 'NBD'. See company-profile.js
        // _tenantFilePrefix for why this must be awaited.
        const _pdfName = window._tenantFileName
          ? await window._tenantFileName(modeTag + 'Report-' + slug + '-' + new Date().toISOString().split('T')[0] + '.pdf')
          : modeTag + 'Report-' + slug + '-' + new Date().toISOString().split('T')[0] + '.pdf';
        window.NBDDocViewer.open({
          html: html,
          title: modeTag + ' Photo Report — ' + name,
          filename: _pdfName,
          onSave: async () => {
            if (typeof showToast === 'function') {
              showToast('\u2713 Photo report ready \u2014 Print or Download PDF from the action bar', 'ok');
            }
          }
        });
      } else {
        // Fallback: legacy popup
        const win = window.open('', '_blank');
        if (win) { win.document.write(html); win.document.close(); }
      }

      if (typeof showToast === 'function') showToast('Photo report generated — print to PDF', 'ok');
    } catch(e) {
      console.error('Photo report failed:', e);
      if (typeof showToast === 'function') showToast('Report generation failed: ' + e.message, 'error');
    }
  }

  // Tiny inline HTML escaper for interpolation safety. Captions and
  // location strings can legitimately carry quotes / ampersands.
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Pick the right caption per photo + mode. Homeowner mode prefers the
  // rep's caption → AI caption → location label, all friendly. Adjuster
  // mode keeps it terse and label-driven (damage/severity surface on the
  // metadata row separately).
  //
  // `p.caption` led both chains and is NEVER WRITTEN by anything — not by the
  // five /photos writers, not by photo-review.js, not by the portal. The field
  // a rep actually types into is `description` (the "Photo description" input,
  // customer-tasks-ui.js:1525, saved by quickSaveMeta at :1611), and the
  // portal's homeowner-facing field is `homeownerCaption` (functions/portal.js
  // :754). So every caption in every report fell straight through to the AI
  // suggestion or the bare location string, and no rep-typed caption had ever
  // appeared in a photo report. `caption` stays in the chain — harmless, and a
  // sixth writer may yet set it — but it can no longer mask the real fields.
  //
  // Homeowner order puts `homeownerCaption` first: types.js:216-219 defines it
  // as the customer-facing override and `description` as the rep-facing note,
  // so an explicit homeowner caption must win. `description` still backs it up,
  // because nothing writes homeownerCaption today and a report with no captions
  // is the actual defect being fixed.
  function _captionFor(p, mode) {
    if (mode === 'adjuster') {
      return p.description
        || p.caption
        || (p.aiSuggestion && p.aiSuggestion.caption)
        || '';
    }
    return p.homeownerCaption
      || p.description
      || p.caption
      || (p.aiSuggestion && p.aiSuggestion.caption)
      || p.location
      || (p.inferredLocation && p.inferredLocation.label)
      || '';
  }
  // ─── damageType canon ────────────────────────────────────────────
  // /photos.damageType was written by four surfaces in four spellings
  // (Title Case editor, Title Case quick-edit, kebab bulk bar, snake AI).
  // docs/pro/js/photo-damage-types.js owns the fold; see its header for
  // the full inventory. Normalizing on READ here means legacy docs pair
  // and label correctly with no backfill dependency.
  //
  // The global is resolved per call, not captured at load: this file is a
  // classic deferred script, and tests/smoke/photo-report-pairs.test.js
  // loads photo-damage-types.js into the SAME vm context before this one.
  // If it is ever genuinely absent the fallback preserves today's
  // behaviour (bare lowercase) instead of throwing mid-report.
  function _dmgNorm(v) {
    const D = window.NBD_PHOTO_DAMAGE;
    return D ? D.normalize(v) : String(v == null ? '' : v).trim().toLowerCase();
  }
  function _dmgLabel(v) {
    const D = window.NBD_PHOTO_DAMAGE;
    return D ? D.label(v) : String(v == null ? '' : v);
  }
  // Damage label — humanize the canonical snake_case enum.
  function _damageLabel(p) {
    return _dmgLabel(p.damageType || (p.aiSuggestion && p.aiSuggestion.damageType) || '');
  }
  function _severityLabel(p) {
    const v = p.severity || (p.aiSuggestion && p.aiSuggestion.severity) || '';
    if (!v) return '';
    return v[0].toUpperCase() + v.slice(1);
  }
  function _locationLabel(p) {
    return p.location || (p.inferredLocation && p.inferredLocation.label) || '';
  }
  // Emits the `src` (+ `srcset`+`sizes` when the variants pipeline has
  // run) for a photo tile. The report renders in a popped-out document
  // that doesn't have window.buildPhotoImgAttrs from customer.html, so
  // we replicate the same shape locally. Without this, the fallback
  // path drops the full-resolution iPhone original (3-5 MB) into every
  // tile — a 40-photo report could pull 200+ MB.
  function _imgAttrs(p, sizes) {
    sizes = sizes || '220px';
    const urls = p && p.urls;
    const primary = /^https?:/i.test(String(p && p.url || '')) ? p.url : '';
    const hasVariants = urls
      && /^https?:/i.test(String(urls.thumb || ''))
      && /^https?:/i.test(String(urls.med   || ''))
      && /^https?:/i.test(String(urls.full  || ''));
    if (!hasVariants) {
      return 'src="' + _esc(primary) + '"';
    }
    const srcset = _esc(urls.thumb) + ' 200w, ' +
                   _esc(urls.med)   + ' 600w, ' +
                   _esc(urls.full)  + ' 1600w';
    const fallback = _esc(urls.med || primary);
    return 'src="' + fallback + '" srcset="' + srcset + '" sizes="' + _esc(sizes) + '"';
  }

  // ─── Before/after pairing (§3.1) ───────────────────────────────────
  // Three tiers, applied in order. Each tier picks the BEFORE with the
  // EARLIEST createdAt (worst initial state) and the AFTER with the
  // LATEST (completed state) per key; photos consumed in one tier
  // aren't reused in later tiers; cap at 8 pairs total.
  //
  //   1. Location match. Normalizes by lowercasing and taking the first
  //      comma-segment so "North slope, ridge" pairs with "North Slope".
  //      Strongest signal — survives every tier above unchanged.
  //   2. Damage-type match. Fills remaining slots when reps tag what
  //      kind of damage but not where (or location strings don't match).
  //   3. Project-overview fallback. If <2 pairs after tiers 1+2 and any
  //      unused before/after exist anywhere, add ONE chronological pair
  //      (earliest before + latest after) labeled "Project overview".
  //      Untagged leads still get a usable report.
  function _buildPairs(allPhotos) {
    const list = Array.isArray(allPhotos) ? allPhotos : [];
    // Normalize a tag/location: lowercase, take first comma-segment,
    // collapse whitespace. Empty string when input lacks the field.
    const normKey = (s) => String(s || '').toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ');
    const ms = (p) => (p && p.createdAt && (p.createdAt.toMillis ? p.createdAt.toMillis() : (p.createdAt.seconds ? p.createdAt.seconds * 1000 : 0))) || 0;
    // `full` before `med`: these URLs become pairs[].before/after.url, which the
    // template renders as the report's largest images (photoReport.hbs:70-80).
    // The dead `urls.lg` used to lead, so the pair heroes silently resolved to
    // the 600px `med` variant. Print wants the 1600px one.
    const urlOf = (p) => (p && p.urls && (p.urls.full || p.urls.med)) || (p && p.url) || '';
    const idOf  = (p) => (p && (p.id || (p.urls && (p.urls.full || p.urls.med)) || p.url)) || '';
    const locOf = (p) => (p && (p.location || (p.inferredLocation && p.inferredLocation.label))) || '';
    // Folded to the canonical id so tier 2 groups by PERIL, not by which
    // surface happened to tag the photo. Before this, a 'granule-loss'
    // before-shot (bulk bar) and a 'granular_loss' after-shot (AI) missed
    // each other, tiers 1+2 came back empty, and tier 3 shipped the two
    // as a chronological pair labeled "Project overview".
    const dmgOf = (p) => _dmgNorm(p && (p.damageType || (p.aiSuggestion && p.aiSuggestion.damageType)));

    const beforePhotos = list.filter(p => String(p && p.phase || '').toLowerCase() === 'before');
    const afterPhotos  = list.filter(p => String(p && p.phase || '').toLowerCase() === 'after');
    if (!beforePhotos.length || !afterPhotos.length) return [];

    // Build a key→best-photo map. `pickEarliest=true` for before tiles,
    // false (= latest wins) for after tiles. Photos already used by an
    // earlier tier are filtered out via `excludeIds`.
    function bestByKey(photos, keyFn, pickEarliest, excludeIds) {
      const map = new Map();
      for (const p of photos) {
        if (!p) continue;
        if (excludeIds && excludeIds.has(idOf(p))) continue;
        const k = keyFn(p);
        if (!k) continue;
        const m = ms(p);
        const cur = map.get(k);
        const better = !cur || (pickEarliest ? m < cur._ms : m > cur._ms);
        if (better) map.set(k, Object.assign({}, p, { _ms: m }));
      }
      return map;
    }

    const used = new Set();
    const out = [];
    function tryTier(beforeMap, afterMap, labelFor) {
      // Sort keys for deterministic order (alphabetical by key).
      const keys = Array.from(beforeMap.keys()).sort();
      for (const k of keys) {
        if (out.length >= 8) return;
        const b = beforeMap.get(k);
        const a = afterMap.get(k);
        if (!b || !a) continue;
        const bId = idOf(b), aId = idOf(a);
        if (used.has(bId) || used.has(aId)) continue;
        const bUrl = urlOf(b), aUrl = urlOf(a);
        if (!bUrl || !aUrl) continue;
        used.add(bId); used.add(aId);
        out.push({
          location: labelFor(k, b, a),
          before: { url: bUrl },
          after:  { url: aUrl },
        });
      }
    }

    // Tier 1: location.
    {
      const bMap = bestByKey(beforePhotos, (p) => normKey(locOf(p)), true,  used);
      const aMap = bestByKey(afterPhotos,  (p) => normKey(locOf(p)), false, used);
      tryTier(bMap, aMap, (k, b) => locOf(b) || k);
    }
    // Tier 2: damage type.
    if (out.length < 8) {
      const bMap = bestByKey(beforePhotos, (p) => normKey(dmgOf(p)), true,  used);
      const aMap = bestByKey(afterPhotos,  (p) => normKey(dmgOf(p)), false, used);
      tryTier(bMap, aMap, (k) => 'Damage: ' + k.replace(/_/g, ' '));
    }
    // Tier 3: chronological overview ONLY when tiers 1+2 found nothing.
    // Original design said `< 2` but that misbehaved: a lead with one
    // location pair AND leftover same-location photos would get a
    // bonus "Project overview" pair pulled from those leftovers,
    // mislabeling them. §3.2 unit-test caught it. With `=== 0` this
    // tier fires only for genuinely untagged leads (its real purpose).
    if (out.length === 0) {
      const remBefore = beforePhotos.filter(p => !used.has(idOf(p)))
        .sort((x, y) => ms(x) - ms(y));
      const remAfter  = afterPhotos.filter(p => !used.has(idOf(p)))
        .sort((x, y) => ms(y) - ms(x));
      const b = remBefore[0], a = remAfter[0];
      if (b && a) {
        const bUrl = urlOf(b), aUrl = urlOf(a);
        if (bUrl && aUrl) {
          out.push({
            location: 'Project overview',
            before: { url: bUrl },
            after:  { url: aUrl },
          });
        }
      }
    }
    return out.slice(0, 8);
  }

  function buildReportHTML(lead, name, before, during, after, dateStr, hasPhases, mode) {
    const isAdjuster = mode === 'adjuster';
    const allPhotos  = before.concat(during).concat(after);
    // The brand-bar logo is an NBD-specific asset (/assets/images/nbd-logo.png)
    // and the brand shape exposes no tenant logo URL, so show it only for NBD;
    // a stranger tenant's brand-bar-name text carries their identity instead.
    const brandIsNbd = _isNbdBrand(_brandRaw());

    // ── Photo tile rendering ─────────────────────────────────────────
    // Homeowner: 4/3 aspect, caption below if available, no metadata
    //   clutter — visual story format.
    // Adjuster:  numbered tile with location + damage·severity + caption,
    //   1/1 aspect for a denser dossier grid.
    // Both modes lock aspect-ratio so phone/drone/closeup photos land
    // uniform — the old report rendered native aspect ratios and looked
    // like a collage.
    const photoGrid = (photos) => photos.map((p, i) => {
      const cap = _captionFor(p, mode);
      const loc = _locationLabel(p);
      const dmg = _damageLabel(p);
      const sev = _severityLabel(p);

      if (isAdjuster) {
        const num = (i + 1).toString().padStart(2, '0');
        return (
          '<div class="ph-tile ph-tile-adj">' +
            '<div class="ph-img"><img ' + _imgAttrs(p, '200px') + ' alt="Photo ' + num + '"></div>' +
            '<div class="ph-meta">' +
              '<div class="ph-num">#' + num + '</div>' +
              (loc ? '<div class="ph-row"><span class="ph-k">Location</span><span class="ph-v">' + _esc(loc) + '</span></div>' : '') +
              (dmg ? '<div class="ph-row"><span class="ph-k">Damage</span><span class="ph-v">' + _esc(dmg) + (sev ? ' · ' + _esc(sev) : '') + '</span></div>' : '') +
              (cap ? '<div class="ph-cap">' + _esc(cap) + '</div>' : '') +
            '</div>' +
          '</div>'
        );
      }
      return (
        '<div class="ph-tile">' +
          '<div class="ph-img"><img ' + _imgAttrs(p, '260px') + ' alt=""></div>' +
          (cap ? '<div class="ph-cap-ho">' + _esc(cap) + '</div>' : '') +
        '</div>'
      );
    }).join('');

    // ── Stats strip (always shown when there's at least 1 photo) ─────
    // Phase counts + AI-severity totals when classifier data exists.
    // This replaces the old "DAMAGE SUMMARY" block in adjuster mode and
    // adds it to homeowner mode too (with friendlier labels).
    const sevCounts = { minor: 0, moderate: 0, severe: 0 };
    let damagedCount = 0;
    for (const p of allPhotos) {
      const s = (p.severity || (p.aiSuggestion && p.aiSuggestion.severity) || '').toLowerCase();
      if (sevCounts.hasOwnProperty(s)) { sevCounts[s]++; damagedCount++; }
    }
    const statCell = (n, label, sub) =>
      '<div class="stat">'
      + '<div class="stat-num">' + n + '</div>'
      + '<div class="stat-label">' + label + '</div>'
      + (sub ? '<div class="stat-sub">' + sub + '</div>' : '')
      + '</div>';
    const stats =
      '<div class="stat-grid">'
      + statCell(allPhotos.length, 'Total Photos', '')
      + (before.length ? statCell(before.length, 'Before', isAdjuster ? 'pre-loss' : 'pre-project') : '')
      + (during.length ? statCell(during.length, 'During', 'in progress') : '')
      + (after.length  ? statCell(after.length,  'After',  'completed') : '')
      + (damagedCount  ? statCell(damagedCount,  'With damage', sevCounts.severe ? sevCounts.severe + ' severe' : '') : '')
      + '</div>';

    // ── Adjuster-only damage breakdown ───────────────────────────────
    // Shown ONLY when there's real data. The old report rendered four
    // labeled cells with em-dash placeholders when fields were empty —
    // that looked like the report itself was broken. Now: render nothing
    // unless at least one of dmg/sev/loc has counts.
    let adjusterSummary = '';
    if (isAdjuster) {
      const dmgCounts = {};
      const locCounts = {};
      for (const p of allPhotos) {
        const d = _damageLabel(p); if (d) dmgCounts[d] = (dmgCounts[d] || 0) + 1;
        const l = _locationLabel(p); if (l) locCounts[l] = (locCounts[l] || 0) + 1;
      }
      const sortPairs = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
      const renderTag = ([k, v]) => '<span class="dmg-tag"><strong>' + v + '</strong> ' + _esc(k) + '</span>';
      const dmgEntries = sortPairs(dmgCounts);
      const sevEntries = Object.entries(sevCounts).filter(([, v]) => v > 0);
      const locEntries = sortPairs(locCounts);
      const hasAnyData = dmgEntries.length || sevEntries.length || locEntries.length;
      if (hasAnyData) {
        const rows = [];
        if (dmgEntries.length) rows.push('<div class="dmg-row"><div class="dmg-row-label">Damage types</div><div class="dmg-row-tags">' + dmgEntries.map(renderTag).join('') + '</div></div>');
        if (sevEntries.length) rows.push('<div class="dmg-row"><div class="dmg-row-label">Severity mix</div><div class="dmg-row-tags">' + sevEntries.map(([k,v]) => '<span class="dmg-tag dmg-sev-' + k + '"><strong>' + v + '</strong> ' + k + '</span>').join('') + '</div></div>');
        if (locEntries.length) rows.push('<div class="dmg-row"><div class="dmg-row-label">Locations covered</div><div class="dmg-row-tags">' + locEntries.slice(0, 10).map(renderTag).join('') + '</div></div>');
        adjusterSummary =
          '<div class="dmg-summary">'
          + '<div class="dmg-summary-title">Damage Summary</div>'
          + rows.join('')
          + '</div>';
      }
    }

    // ── Before / After pair section (homeowner mode — visual story) ──
    // The pairs come from _buildPairs which we run on the full photo set
    // earlier in the server-render code path. For the standalone fallback
    // we re-run it here so the homeowner version gets the showcase grid.
    let pairsSection = '';
    if (!isAdjuster) {
      const pairs = _buildPairs(allPhotos);
      if (pairs.length) {
        const items = pairs.map((pair) => (
          '<div class="ba-pair">'
          + '<div class="ba-cell"><div class="ba-frame"><img src="' + _esc(pair.before.url) + '" alt="Before"><div class="ba-stamp">Before</div></div></div>'
          + '<div class="ba-cell"><div class="ba-frame"><img src="' + _esc(pair.after.url)  + '" alt="After"><div class="ba-stamp ba-after">After</div></div></div>'
          + '<div class="ba-loc">' + _esc(pair.location) + '</div>'
          + '</div>'
        )).join('');
        pairsSection =
          '<div class="section avoid-break">'
          + '<div class="section-eyebrow">The Transformation</div>'
          + '<div class="section-title">Before &amp; After</div>'
          + '<p class="section-lead">Side-by-side comparisons of the same locations at start and finish.</p>'
          + '<div class="ba-grid">' + items + '</div>'
          + '</div>';
      }
    }

    // Cover photo for the homeowner hero — first BEFORE photo that
    // has a usable URL. Adjuster mode skips the hero to keep dense.
    const heroPhoto = !isAdjuster ? before.find(p => (p.urls && (p.urls.full || p.urls.med)) || p.url) : null;
    const heroUrl = heroPhoto ? ((heroPhoto.urls && (heroPhoto.urls.full || heroPhoto.urls.med)) || heroPhoto.url) : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${isAdjuster ? 'Adjuster' : 'Homeowner'} Photo Report — ${_esc(name)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap">
</head>
<body data-report-mode="${isAdjuster ? 'adjuster' : 'homeowner'}">
<style>
  /* All colors / typography / spacing inlined — no external token
     dependencies. The fallback renders in a doc-viewer iframe that
     historically failed to load nbd-brand.css; the report then
     collapsed visually. This is a print-friendly light theme with
     explicit hex values, identical in every render context. */
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{ background:#ffffff; }
  body{
    font-family: 'Lato', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color:#111827;
    line-height:1.55;
    -webkit-font-smoothing: antialiased;
  }
  h1,h2,h3,h4{ font-family:'Montserrat','Lato','Segoe UI',Helvetica,Arial,sans-serif; font-weight:800; letter-spacing:.02em; line-height:1.15; color:#111827; }
  @media print{
    .no-print{ display:none!important; }
    body{ margin:0; }
    @page{ margin:0.5in; }
    .section,.ba-pair,.ph-tile{ break-inside: avoid; }
    .page-break{ page-break-before: always; }
  }

  /* ── No-print top bar (Close / Print) ────────────────────────── */
  .top-bar{
    position:fixed; top:0; left:0; right:0; height:52px;
    background:#ffffff; border-bottom:1px solid #e5e7eb;
    display:flex; align-items:center; justify-content:space-between;
    padding:0 20px; z-index:1000;
    box-shadow:0 1px 3px rgba(0,0,0,.06);
  }
  .top-bar-btn{
    padding:8px 16px; background:#f3f4f6;
    border:1px solid #e5e7eb; border-radius:8px;
    color:#111827; font-weight:700; font-size:13px;
    cursor:pointer; font-family:inherit;
  }
  .top-bar-btn-primary{ background:var(--orange,#BD5728); border-color:var(--orange,#BD5728); color:#ffffff; }
  .top-bar-btn-primary:hover{ background:#A14A22; }
  .top-bar-mode{ color:#6b7280; font-size:13px; }

  /* ── Hero / cover band ───────────────────────────────────────── */
  .hero{
    position:relative;
    background:linear-gradient(135deg,#fffaf4 0%,#ffffff 60%);
    border-bottom:1px solid #e5e7eb;
    padding:48px 56px 36px;
    overflow:hidden;
  }
  .hero-eyebrow{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:11px; font-weight:700;
    letter-spacing:.18em; text-transform:uppercase;
    color:var(--orange,#BD5728); margin-bottom:10px;
  }
  .hero-title{
    font-size:42px; font-weight:800;
    color:#111827; letter-spacing:.01em;
    margin-bottom:8px;
  }
  .hero-sub{
    font-size:14px; color:#6b7280;
    max-width:560px; line-height:1.5;
  }
  .hero-photo{
    position:absolute; right:-40px; top:50%;
    transform:translateY(-50%);
    width:340px; height:220px;
    border-radius:14px; overflow:hidden;
    box-shadow:0 10px 30px rgba(0,0,0,.18);
    border:6px solid #ffffff;
  }
  .hero-photo img{ width:100%; height:100%; object-fit:cover; display:block; }
  @media (max-width:820px){ .hero-photo{ display:none; } .hero{ padding:36px 24px 28px; } .hero-title{ font-size:30px; } }

  /* ── Brand band ──────────────────────────────────────────────── */
  .brand-bar{
    display:flex; align-items:center; justify-content:space-between;
    padding:14px 56px; background:#111827; color:#f9fafb;
    font-size:12px; gap:16px;
  }
  .brand-bar-left{ display:flex; align-items:center; gap:14px; }
  .brand-logo{ height:32px; width:auto; display:block; }
  .brand-bar-name{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-weight:800; color:#ffffff;
    text-transform:uppercase; letter-spacing:.06em; font-size:14px;
  }
  .brand-bar-contact{ color:#d1d5db; font-size:12px; }
  @media (max-width:600px){ .brand-bar{ padding:14px 24px; flex-direction:column; gap:8px; text-align:center; } }

  /* ── Content shell ───────────────────────────────────────────── */
  .content{ max-width:920px; margin:0 auto; padding:32px 56px 64px; }
  @media (max-width:820px){ .content{ padding:24px 20px 48px; } }

  /* ── Property info card ──────────────────────────────────────── */
  .info-card{
    border:1px solid #e5e7eb; border-radius:12px;
    padding:20px 24px; margin-bottom:32px;
    background:#fafafa;
    display:grid; grid-template-columns:1fr 1fr; gap:14px 32px;
    font-size:13.5px;
  }
  .info-card .info-k{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:10px; font-weight:700;
    letter-spacing:.14em; text-transform:uppercase;
    color:#9ca3af; margin-bottom:2px;
  }
  .info-card .info-v{ color:#111827; font-weight:600; }
  @media (max-width:600px){ .info-card{ grid-template-columns:1fr; padding:16px 18px; } }

  /* ── Stats strip ─────────────────────────────────────────────── */
  .stat-grid{
    display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
    gap:12px; margin-bottom:32px;
  }
  .stat{
    border:1px solid #e5e7eb; border-radius:10px;
    background:#ffffff; padding:14px 16px; text-align:left;
  }
  .stat-num{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:32px; font-weight:800;
    color:var(--orange,#BD5728); line-height:1;
  }
  .stat-label{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:11px; font-weight:700;
    letter-spacing:.12em; text-transform:uppercase;
    color:#374151; margin-top:8px;
  }
  .stat-sub{ font-size:11px; color:#9ca3af; margin-top:2px; }

  /* ── Adjuster Damage Summary (only when has-data) ───────────── */
  .dmg-summary{
    border:1px solid #e5e7eb; border-radius:12px;
    background:#fffaf4; padding:18px 22px; margin-bottom:32px;
  }
  .dmg-summary-title{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:11px; font-weight:700;
    letter-spacing:.16em; text-transform:uppercase;
    color:#A14A22; margin-bottom:12px;
  }
  .dmg-row{ display:flex; align-items:flex-start; gap:14px; margin-bottom:10px; flex-wrap:wrap; }
  .dmg-row:last-child{ margin-bottom:0; }
  .dmg-row-label{
    flex-shrink:0; width:130px;
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:11px; font-weight:700;
    letter-spacing:.1em; text-transform:uppercase;
    color:#6b7280; padding-top:3px;
  }
  .dmg-row-tags{ flex:1; display:flex; flex-wrap:wrap; gap:6px; }
  .dmg-tag{
    display:inline-flex; align-items:center; gap:4px;
    padding:3px 10px; border-radius:999px;
    background:#ffe8d5; color:#A14A22;
    font-size:11px; font-weight:600;
  }
  .dmg-tag strong{ font-weight:800; }
  .dmg-sev-minor   { background:#fef9c3; color:#854d0e; }
  .dmg-sev-moderate{ background:#ffedd5; color:#9a3412; }
  .dmg-sev-severe  { background:#fee2e2; color:#991b1b; }

  /* ── Section headers ─────────────────────────────────────────── */
  .section{ margin-bottom:40px; }
  .section-eyebrow{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:11px; font-weight:700;
    letter-spacing:.16em; text-transform:uppercase;
    color:var(--orange,#BD5728); margin-bottom:6px;
  }
  .section-title{
    font-size:26px; font-weight:800;
    color:#111827; margin-bottom:8px;
  }
  .section-lead{
    color:#6b7280; font-size:14px;
    max-width:560px; margin-bottom:18px;
  }
  .section-count{
    color:#9ca3af; font-size:13px; font-weight:500;
    margin-left:8px;
  }
  .section-eyebrow.is-before{ color:#dc2626; }
  .section-eyebrow.is-during{ color:var(--orange,#BD5728); }
  .section-eyebrow.is-after { color:#16a34a; }

  /* ── Before/After pair grid (homeowner showcase) ─────────────── */
  .ba-grid{ display:grid; grid-template-columns:1fr; gap:24px; }
  .ba-pair{
    display:grid; grid-template-columns:1fr 1fr; gap:12px;
    border:1px solid #e5e7eb; border-radius:14px;
    background:#ffffff; padding:14px;
  }
  .ba-cell{ position:relative; }
  .ba-frame{
    position:relative; aspect-ratio:4/3;
    border-radius:10px; overflow:hidden;
    background:#f3f4f6;
  }
  .ba-frame img{ width:100%; height:100%; object-fit:cover; display:block; }
  .ba-stamp{
    position:absolute; left:10px; top:10px;
    background:#dc2626; color:#ffffff;
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:11px; font-weight:800;
    letter-spacing:.12em; text-transform:uppercase;
    padding:4px 10px; border-radius:6px;
    box-shadow:0 2px 6px rgba(0,0,0,.18);
  }
  .ba-stamp.ba-after{ background:#16a34a; }
  .ba-loc{
    grid-column:1/-1;
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-size:13px; font-weight:700;
    letter-spacing:.05em; text-transform:uppercase;
    color:#374151; padding:8px 4px 2px;
  }

  /* ── Photo tile grid ─────────────────────────────────────────── */
  .photo-grid{
    display:grid;
    grid-template-columns:repeat(3,1fr);
    gap:14px;
  }
  @media (max-width:820px){ .photo-grid{ grid-template-columns:repeat(2,1fr); } }
  @media (max-width:520px){ .photo-grid{ grid-template-columns:1fr; } }
  .ph-tile{
    border:1px solid #e5e7eb; border-radius:10px;
    background:#ffffff; overflow:hidden;
    display:flex; flex-direction:column;
  }
  .ph-img{
    aspect-ratio:4/3; background:#f3f4f6;
    overflow:hidden; position:relative;
  }
  .ph-img img{ width:100%; height:100%; object-fit:cover; display:block; }
  .ph-cap-ho{
    padding:10px 12px; font-size:12px;
    color:#6b7280; line-height:1.4;
    border-top:1px solid #f3f4f6;
  }

  /* Adjuster tile = square, dense metadata under image */
  .photo-grid.is-adjuster{ grid-template-columns:repeat(4,1fr); gap:10px; }
  @media (max-width:820px){ .photo-grid.is-adjuster{ grid-template-columns:repeat(3,1fr); } }
  @media (max-width:520px){ .photo-grid.is-adjuster{ grid-template-columns:repeat(2,1fr); } }
  .ph-tile-adj .ph-img{ aspect-ratio:1/1; }
  .ph-meta{
    padding:8px 10px; background:#fafafa;
    border-top:1px solid #f3f4f6;
    font-size:11px; line-height:1.4;
  }
  .ph-num{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-weight:800; font-size:11px;
    letter-spacing:.1em; color:var(--orange,#BD5728);
    margin-bottom:4px;
  }
  .ph-row{ display:grid; grid-template-columns:60px 1fr; gap:6px; margin-bottom:2px; }
  .ph-k{
    color:#9ca3af; font-weight:700;
    letter-spacing:.06em; text-transform:uppercase;
    font-size:9.5px; align-self:center;
  }
  .ph-v{ color:#111827; font-weight:500; font-size:11px; }
  .ph-cap{
    color:#6b7280; font-size:11px;
    margin-top:6px; padding-top:6px;
    border-top:1px dashed #e5e7eb;
    line-height:1.4;
  }

  /* ── Work performed narrative ────────────────────────────────── */
  .scope-block{
    border-left:3px solid #BD5728;
    padding:8px 0 8px 18px; margin-bottom:32px;
  }
  .scope-block h2{ font-size:22px; margin-bottom:10px; }
  .scope-block p{ font-size:14px; color:#374151; line-height:1.65; white-space:pre-line; }

  /* ── Footer / brand seal ─────────────────────────────────────── */
  .footer{
    border-top:1px solid #e5e7eb;
    margin-top:40px; padding:24px 56px 12px;
    background:#fafafa;
    font-size:12px; color:#6b7280; text-align:center;
  }
  .footer-brand{
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    font-weight:800; color:#111827;
    text-transform:uppercase; letter-spacing:.08em;
    font-size:14px; margin-bottom:4px;
  }
  .footer-tag{
    font-style:italic; color:var(--orange,#BD5728);
    font-size:11px; margin-top:6px;
    font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
    letter-spacing:.06em; text-transform:uppercase;
  }
</style>

<!-- No-print top bar -->
<div class="no-print top-bar">
  <div style="display:flex;align-items:center;gap:12px;">
    <button id="rpt-close-btn" class="top-bar-btn">&#8592; Close</button>
    <span class="top-bar-mode">${isAdjuster ? 'Adjuster Report' : 'Homeowner Report'}</span>
  </div>
  <button id="rpt-print-btn" class="top-bar-btn top-bar-btn-primary">Print / Save PDF</button>
</div>
<div style="height:52px;"></div>
<script>
  // The report renders inside its own window/viewer; wire the top-bar
  // buttons via addEventListener so CSP \`script-src-attr 'none'\`
  // doesn't block them the way inline onclick="..." would.
  (function(){
    var c = document.getElementById('rpt-close-btn');
    var p = document.getElementById('rpt-print-btn');
    if (c) c.addEventListener('click', function(){ window.close(); });
    if (p) p.addEventListener('click', function(){ window.print(); });
  })();
<\/script>

<!-- Hero -->
<header class="hero">
  <div class="hero-eyebrow">${isAdjuster ? 'Loss Documentation · Adjuster Copy' : 'Project Story · Before &amp; After'}</div>
  <h1 class="hero-title">${isAdjuster ? 'Claim Photo Documentation' : _esc(name) + '’s Project'}</h1>
  <div class="hero-sub">${isAdjuster
    ? 'Photographic evidence of property condition before, during, and after the scope of work performed by ' + _esc(BRAND.name) + '. Every image stamped with location, damage type, and severity where applicable.'
    : 'A visual walkthrough of your roof project — what we found, the work as it happened, and the result.'}</div>
  ${heroUrl ? '<div class="hero-photo"><img src="' + _esc(heroUrl) + '" alt=""></div>' : ''}
</header>

<!-- Brand band -->
<div class="brand-bar">
  <div class="brand-bar-left">
    ${brandIsNbd ? `<img class="brand-logo" src="/assets/images/nbd-logo.png" alt="${_esc(BRAND.name)}">` : ''}
    <span class="brand-bar-name">${_esc(BRAND.name)}</span>
  </div>
  <span class="brand-bar-contact">${_esc(BRAND.phone)} &nbsp;·&nbsp; ${_esc(BRAND.email)} &nbsp;·&nbsp; ${_esc(BRAND.website)}</span>
</div>

<main class="content">

  <!-- Property info -->
  <div class="info-card">
    <div>
      <div class="info-k">${isAdjuster ? 'Insured' : 'Property Owner'}</div>
      <div class="info-v">${_esc(name)}</div>
    </div>
    <div>
      <div class="info-k">${isAdjuster ? 'Loss Type' : 'Project'}</div>
      <div class="info-v">${_esc(lead.jobType || lead.damageType || 'Exterior')}</div>
    </div>
    <div>
      <div class="info-k">Address</div>
      <div class="info-v">${_esc(lead.address || '—')}</div>
    </div>
    <div>
      <div class="info-k">Date</div>
      <div class="info-v">${_esc(dateStr)}</div>
    </div>
    ${isAdjuster && lead.claimNumber ? '<div><div class="info-k">Claim #</div><div class="info-v">' + _esc(lead.claimNumber) + '</div></div>' : ''}
    ${isAdjuster && (lead.insCarrier || lead.insuranceCarrier) ? '<div><div class="info-k">Carrier</div><div class="info-v">' + _esc(lead.insCarrier || lead.insuranceCarrier) + '</div></div>' : ''}
  </div>

  <!-- Stats strip -->
  ${stats}

  <!-- Damage summary (adjuster only, only when has-data) -->
  ${adjusterSummary}

  <!-- Before/After pairs (homeowner showcase) -->
  ${pairsSection}

  ${before.length > 0 ? `<section class="section">
    <div class="section-eyebrow is-before">${hasPhases ? 'Before' : 'Project Photos'}</div>
    <h2 class="section-title">${hasPhases ? 'Pre-Project Condition' : 'Documentation'}<span class="section-count">${before.length} photo${before.length === 1 ? '' : 's'}</span></h2>
    <p class="section-lead">${isAdjuster
      ? (hasPhases ? 'Documentation of property condition prior to work commencing.' : 'Photographic record of the property.')
      : (hasPhases ? 'Photos of the property at the start of the project.' : 'Photos of your project.')}</p>
    <div class="photo-grid${isAdjuster ? ' is-adjuster' : ''}">${photoGrid(before)}</div>
  </section>` : ''}

  ${lead.scopeOfWork ? `<section class="scope-block">
    <h2>Work Performed</h2>
    <p>${_esc(lead.scopeOfWork)}</p>
  </section>` : ''}

  ${during.length > 0 ? `<section class="section">
    <div class="section-eyebrow is-during">During</div>
    <h2 class="section-title">Work In Progress<span class="section-count">${during.length} photo${during.length === 1 ? '' : 's'}</span></h2>
    <p class="section-lead">${isAdjuster ? 'Mid-project documentation of work in progress.' : 'Photos taken while the crew was on the property.'}</p>
    <div class="photo-grid${isAdjuster ? ' is-adjuster' : ''}">${photoGrid(during)}</div>
  </section>` : ''}

  ${after.length > 0 ? `<section class="section">
    <div class="section-eyebrow is-after">After</div>
    <h2 class="section-title">Completed Project<span class="section-count">${after.length} photo${after.length === 1 ? '' : 's'}</span></h2>
    <p class="section-lead">${isAdjuster ? 'Final-condition documentation post-completion.' : 'The finished work — what the property looks like now.'}</p>
    <div class="photo-grid${isAdjuster ? ' is-adjuster' : ''}">${photoGrid(after)}</div>
  </section>` : ''}

</main>

<footer class="footer">
  <div class="footer-brand">${_esc(BRAND.name)}</div>
  <div>${_esc(BRAND.phone)} &nbsp;·&nbsp; ${_esc(BRAND.email)} &nbsp;·&nbsp; ${_esc(BRAND.website)}</div>
  ${BRAND.tagline ? `<div class="footer-tag">${_esc(BRAND.tagline)}</div>` : ''}
</footer>

</body>
</html>`;
  }

  // ═════════════════════════════════════════════════════════
  // D-6: Report options
  // ═════════════════════════════════════════════════════════
  // D-4 gave the rep one choice — homeowner or adjuster — and hardcoded every
  // other decision: the cover lines, the section order and headings, the
  // summary prose, whether photos were numbered (they were not), how many to a
  // row, what metadata showed. This is the contract that replaces those
  // literals. Every field has a per-mode default, so an existing caller that
  // passes nothing gets a sensible report and a caller that passes one key
  // changes exactly that.
  //
  // The two modes are genuinely different documents, so they default
  // differently: the homeowner report is a story (big photos, no clutter, no
  // dates), the adjuster dossier is an exhibit list (numbered continuously,
  // dated, dense, signed).
  const REPORT_DEFAULTS = {
    homeowner: {
      cover: 'hero', density: 'comfortable', columns: 0, fit: 'cover',
      numbering: 'continuous', numberLabel: '',
      showToc: false, showStats: true, showPairs: true,
      showDate: false, showLocation: true, showDamage: false, showSeverity: false,
      signature: 'none', sharedOnly: 'auto',
    },
    adjuster: {
      cover: 'hero', density: 'evidence', columns: 3, fit: 'contain',
      numbering: 'continuous', numberLabel: 'Photo',
      showToc: true, showStats: true, showPairs: false,
      showDate: true, showLocation: true, showDamage: true, showSeverity: true,
      signature: 'adjuster', sharedOnly: false,
    },
  };
  const _DENSITIES = ['comfortable', 'compact', 'evidence'];
  const _COVERS = ['hero', 'minimal', 'none'];
  const _NUMBERINGS = ['continuous', 'section', 'none'];
  const _SIGNATURES = ['none', 'homeowner', 'adjuster', 'both'];

  /**
   * Merge caller overrides onto the mode defaults, coercing every enum to a
   * known value. Unknown strings fall back rather than reaching the template,
   * where an unmatched density class would silently style nothing and an
   * unmatched numbering would silently drop every photo number.
   * Pure. Registered on __NBD_CALL_REGISTRY as _photoReportOptions (NOT on
   * window) for customer-photo-report-picker.js; tests vm-slice it directly.
   */
  function _reportOptions(mode, o) {
    const base = REPORT_DEFAULTS[mode === 'adjuster' ? 'adjuster' : 'homeowner'];
    const out = Object.assign({}, base, o || {});
    const oneOf = (v, list, dflt) => (list.indexOf(String(v)) >= 0 ? String(v) : dflt);
    out.cover     = oneOf(out.cover, _COVERS, base.cover);
    out.density   = oneOf(out.density, _DENSITIES, base.density);
    out.numbering = oneOf(out.numbering, _NUMBERINGS, base.numbering);
    out.signature = oneOf(out.signature, _SIGNATURES, base.signature);
    out.fit       = out.fit === 'contain' ? 'contain' : 'cover';
    const cols = Number(out.columns);
    out.columns = (cols >= 1 && cols <= 4) ? Math.floor(cols) : 0;
    ['showToc', 'showStats', 'showPairs', 'showDate', 'showLocation', 'showDamage', 'showSeverity']
      .forEach((k) => { out[k] = out[k] !== false; });
    // Re-apply the defaults' explicit falses: the loop above coerces undefined
    // to true, which is right for an omitted key but wrong for a default of
    // false that the caller did not override.
    Object.keys(base).forEach((k) => {
      if (typeof base[k] === 'boolean' && !(o && Object.prototype.hasOwnProperty.call(o, k))) out[k] = base[k];
    });
    return out;
  }

  /**
   * "Aug 14, 2026" for a photo, from whichever timestamp the writer happened to
   * leave. /photos is schema-less and its writers do not agree: photo-engine
   * stamps capturedAt alongside createdAt, the customer page stamps date +
   * uploadedAt, the portal's homeowner upload stamps uploadedAt, the dashboard
   * quick-upload and the annotated-copy path stamp createdAt. Every create path
   * stamps createdAt as of 2026-09-08 (tests/photos-timestamp-contract.test.js
   * is the guard), but docs written before that — and every legacy doc the
   * backfill has not reached — still carry only the older fields.
   * Pure. Exported as window._photoReportDateLabel for tests.
   */
  function _dateLabel(p) {
    // Field resolution and shape coercion both live in _photoTimestampMs, which
    // _comparePhotoReportOrder also calls. Two copies of this chain is how the
    // caption and the position drift apart.
    const ms = _photoTimestampMs(p);
    if (!ms) return '';
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /**
   * Stamp `n` on every photo across the ordered section list.
   *   'continuous' — 1..N across the whole document, so an adjuster citing
   *                  "Photo 7" means one frame. This is why it is the default:
   *                  the client fallback numbered per section, restarting at
   *                  #01 three times, which makes a citation ambiguous.
   *   'section'    — restart per section.
   *   'none'       — no numbers.
   * Mutates the photo objects in place and returns the sections.
   * Pure apart from that. Exported as window._numberReportSections for tests.
   */
  function _numberSections(sections, numbering) {
    let running = 0;
    (sections || []).forEach((s) => {
      let within = 0;
      (s.photos || []).forEach((p) => {
        running++; within++;
        if (numbering === 'none') delete p.n;
        else p.n = (numbering === 'section') ? within : running;
      });
    });
    return sections;
  }

  // ═════════════════════════════════════════════════════════
  // Report number
  // ═════════════════════════════════════════════════════════
  //
  // It used to be `(mode === 'adjuster' ? 'ADJ-' : 'PHO-') + Date.now()
  // .toString().slice(-6)`. That number is printed on the cover, in the
  // masthead, and — since the running-footer fix — on every page, so it is the
  // string a homeowner or an adjuster quotes back. It changed on every
  // regeneration of the same report, which means "report PHO-482913" named a
  // document that no longer existed under that name the moment the rep
  // re-rendered it. Two reports rendered in the same millisecond window
  // collided, and nothing about it carried the tenant, the date, or the lead.
  //
  // The shape now follows the house convention the hand-built client PDFs use
  // (`NBD-2026-0902-HILD`, SESSION-2026-09-07-client-pdfs-and-drive-tidy) with
  // the type infix the CRM's own generators already use (`-V2-` on estimates,
  // `-WC` on warranty certs):
  //
  //     <TENANT>-<PHO|ADJ>-<YYYY>-<MMDD>-<NNNN>      e.g. NBD-PHO-2026-0908-4471
  //
  // The prefix is `_tenantIdPrefix()`, NOT a literal 'NBD'. This is a
  // multi-tenant CRM and a hardcoded platform prefix on a contractor's own
  // paper is the exact defect estimate-finalization.js:267 and
  // company-profile.js:619 are both written up around — "blank beats wrong",
  // and where blank is not available (an identifier cannot be orphaned into
  // `-2026-0908-4471`) the neutral 'CUS' beats another tenant's identity.
  const _MODE_TAG = { adjuster: 'ADJ', homeowner: 'PHO' };

  // FNV-1a/32 → NNNN. Same hash and the same posture as
  // document-generator.js:757 `_seededDocNumber`: collisions are acceptable
  // because this is a display reference, not an idempotency key. Seeded on
  // (leadId, mode) rather than the clock so that two devices — or the same
  // device after a failed lookup — derive the SAME number for the same report.
  function _reportSeed(parts, len) {
    const n = len || 4;
    const s = (parts || []).filter(Boolean).map(String).join('|');
    if (!s) return String(Date.now()).slice(-n);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString().padStart(n, '0').slice(-n);
  }

  // Local calendar date, not toISOString() — the number is read by the rep and
  // the homeowner in their own timezone, and a report built at 8pm EDT must not
  // be stamped with tomorrow's date.
  function _reportDateStamp(when) {
    const d = when || new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + p2(d.getDate());
  }

  function _mintReportNumber(prefix, leadId, mode, when) {
    return prefix + '-' + (_MODE_TAG[mode] || _MODE_TAG.homeowner)
      + '-' + _reportDateStamp(when) + '-' + _reportSeed([leadId, mode]);
  }

  /**
   * The number already filed for this (lead, mode), if there is one.
   *
   * Equality-only on `source` and sorted in memory, for the reason
   * customer-documents.js:88 spells out: a two-equality-plus-orderBy query
   * needs a composite index, and an index-less query fails CLOSED — which here
   * would silently renumber a report that already has a number.
   *
   * The EARLIEST matching row wins, because a number is assigned once. That
   * includes a legacy `PHO-482913` row: a number already in a customer's hands
   * is worth more than a tidy format, so old reports keep their old number and
   * only new ones get the new shape.
   *
   * Never throws — a rules denial (a `viewer` on a teammate's lead) or an
   * offline client must not stop the report rendering.
   */
  async function _filedReportNumber(leadId, mode) {
    try {
      if (!leadId || !window.db || !window.getDocs || !window.collection
          || !window.query || !window.where) return '';
      const snap = await window.getDocs(window.query(
        window.collection(window.db, 'leads', leadId, 'documents'),
        window.where('source', '==', 'photo_report')
      ));
      let best = null;
      snap.forEach((s) => {
        const d = s.data() || {};
        if (d.deleted === true) return;
        // Rows filed before reportMode existed are homeowner reports — that
        // was the only mode the dashboard chip could produce.
        if ((d.reportMode || 'homeowner') !== mode) return;
        if (!d.reportNumber) return;
        const ms = (d.uploadedAt && typeof d.uploadedAt.toMillis === 'function')
          ? d.uploadedAt.toMillis() : Number.POSITIVE_INFINITY;
        if (!best || ms < best.ms) best = { ms: ms, number: String(d.reportNumber) };
      });
      return best ? best.number : '';
    } catch (e) {
      console.warn('[photo-report] could not read filed report numbers:', e && e.message);
      return '';
    }
  }

  async function _resolveReportNumber(leadId, mode) {
    // Resolve the tenant prefix FIRST and unconditionally — including on the
    // reuse path, which will not use it. `_tenantIdPrefix()` awaits
    // company-profile hydration, and everything after this call reads
    // `window._brand()` SYNCHRONOUSLY to build the cover. estimate-v2-ui.js:3377
    // is the write-up of what happens when that ordering is left to chance:
    // hydration there was "a side effect of an await sitting inside an argument
    // list… an accident, not a guarantee". Awaiting it on its own line, before
    // either branch, makes it a guarantee.
    const prefix = (window._tenantIdPrefix ? await window._tenantIdPrefix() : '') || 'CUS';
    const filed = await _filedReportNumber(leadId, mode);
    return filed || _mintReportNumber(prefix, leadId, mode);
  }

  /**
   * Record a rendered report on leads/{leadId}/documents.
   *
   * Shape matches customer-signed-doc-upload.js:49 so the Documents tab paints
   * it with no special case — customer-documents.js reads that subcollection
   * and is the list a rep actually looks at.
   *
   * `storagePath` is stored alongside `url` on purpose. render-pdf.js returns a
   * 7-day signed URL where the compute SA can reach IAM signBlob, and a
   * never-expiring download-token URL where it cannot (render-pdf.js:500-518),
   * so the recorded link may go dead after a week. The path does not, which is
   * what a future re-sign or a share link needs.
   *
   * `reportOptions` records what the rep chose, so the same document can be
   * regenerated later instead of rebuilt from memory.
   *
   * Never throws — see the caller.
   */
  async function _fileReportOnLead(leadId, rec) {
    try {
      if (!leadId || !window.addDoc || !window.collection || !window.db) return;
      const uid = (window._user && window._user.uid) || null;
      await window.addDoc(window.collection(window.db, 'leads', leadId, 'documents'), {
        name: rec.name,
        url: rec.url,
        storagePath: rec.storagePath || '',
        type: 'application/pdf',
        size: rec.bytes || 0,
        uploadedAt: window.serverTimestamp ? window.serverTimestamp() : null,
        uploadedBy: uid,
        source: 'photo_report',
        reportMode: rec.mode,
        reportNumber: rec.reportNumber || '',
        reportOptions: rec.options || null,
      });
      // Two refreshes for the same reason logGeneratedDoc does it
      // (customer-tasks-ui.js:2261): the write and the list read race, and both
      // are idempotent.
      if (window.NBDCustomerDocs && typeof window.NBDCustomerDocs.refresh === 'function') {
        window.NBDCustomerDocs.refresh();
        setTimeout(function () { window.NBDCustomerDocs.refresh(); }, 2500);
      }
    } catch (e) {
      // Filing is a bonus on top of a report the rep already has, so this is
      // warn-and-continue rather than an error.
      //
      // A `sales_rep` or `viewer` on a teammate's lead is the expected denial:
      // firestore.rules allows WRITE on leads/{id}/documents to the lead's
      // owner or to same-company STAFF (company_admin|manager), while READ also
      // admits a viewer. Managers do file successfully — that clause was the
      // 2026-07 manager-edit-rights pass finishing the job it started on
      // activity/tasks/notes, and it landed with this feature because fixing
      // the photo query scope is what made a manager able to reach the report
      // at all.
      console.warn('[photo-report] could not file the report on the lead:', e && e.message);
    }
  }

  // ═════════════════════════════════════════════════════════
  // D-4: Server-side photo-report render
  // ═════════════════════════════════════════════════════════
  async function _tryServerRenderPhotoReport(opts) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    const { lead, name, before, during, after, mode, allPhotos } = opts;

    if (typeof showToast === 'function') showToast('Rendering photo report…', 'ok');

    // Shape each phase into the template's photo cell payload.
    //
    // Variant keys are `thumb` / `med` / `full` — image-pipeline.js:105-109
    // names them off VARIANTS[].name. This read asked for `urls.lg || urls.md`,
    // neither of which has ever existed, so EVERY server-rendered report fell
    // through to `p.url`: the original camera upload, at full sensor
    // resolution, once per photo. Twenty of those inside the renderer's 25s
    // setContent budget (render-pdf.js:436) is a large part of why this path
    // times out and drops to the client fallback. `_imgAttrs` at :260-262, in
    // this same file, had the names right the whole time.
    //
    // `full` is 1600px wide (image-pipeline.js:108) — a 2-up cell on Letter
    // inside 18mm margins is ~85mm ≈ 1000px at 300dpi, so `full` is the
    // correct print source and `med` (600px) is the degraded fallback.
    const shapePhoto = (p) => {
      const url = (p && p.urls && (p.urls.full || p.urls.med)) || (p && p.url) || '';
      if (!url) return null;
      return {
        url,
        caption:  _captionFor(p, mode) || p.aiCaption || '',
        location: p.location || '',
        damageType: _damageLabel(p) || p.damageType || '',
        severity: _severityLabel(p) || p.severity || '',
        // Capture date — the field that makes a frame evidentiary, captured by
        // the ingest pipeline since day one and never once printed.
        dateLabel: _dateLabel(p),
        // A marked-up frame has to be declarable, because the attestation says
        // so. photo-editor.js bakes drawn markup into the saved image, so a
        // report that called every frame unmodified was making a false
        // statement to a carrier.
        annotated: !!p.isAnnotated,
      };
    };
    const shape = (arr) => (arr || []).map(shapePhoto).filter(Boolean);

    // Auto-pair before/after — three-tier heuristic (§3.1).
    // Tier 1: normalized location → Tier 2: damageType → Tier 3:
    // chronological "Project overview" when <2 pairs found. See
    // _buildPairs at the top of this module for the full picker logic.
    const pairs = _buildPairs(allPhotos);

    const beforeShaped = shape(before);
    const duringShaped = shape(during);
    const afterShaped  = shape(after);

    // Resolve (or reuse) the report number BEFORE any brand read. This awaits
    // company-profile hydration as well as the filed-number lookup — see
    // _resolveReportNumber — so the synchronous window._brand() below is
    // reading a hydrated profile rather than the NBD defaults company-profile.js
    // seeds at parse time.
    const reportNumber = await _resolveReportNumber(lead.id, mode);

    // gauntlet Batch 3 — the cover page renders preparedBy VERBATIM (the server
    // {{company}} chrome does not override it), so de-brand it here or a stranger
    // tenant's report cover would still read "No Big Deal Home Solutions ·
    // (859) 420-7382". NBD keeps the exact literals → byte-identical. Mirrors
    // customer-photo-report-generator.js.
    const _b = (window._brand && window._brand()) || null;
    const isNbd = !_b || !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
    const _bc = (_b && _b.contact) || {};

    // Cover-page payload (shared partial)
    const preparedFor = {
      name,
      address:     lead.address || '',
      customerId:  lead.customerId || null,
      projectLine: lead.damageType ? lead.damageType : null,
    };
    const preparedBy = {
      name:  (window._user && window._user.displayName) || (isNbd ? 'Joe Deal' : (_b.legalName || '')),
      role:  (mode === 'adjuster' ? 'Documentation · ' : 'Project Owner · ') + (isNbd ? 'No Big Deal Home Solutions' : _b.legalName),
      phone: isNbd ? '(859) 420-7382' : (_bc.phone || ''),
      email: isNbd ? 'jd@nobigdealwithjoedeal.com' : (_bc.email || ''),
    };
    const projectMeta = [
      { label: 'Report Date', value: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) },
      { label: 'Total Photos', value: String((allPhotos || []).length) },
      { label: 'Report No.', value: reportNumber },
    ];

    const summary = mode === 'adjuster'
      ? {
          headline: 'Photographic evidence dossier',
          body: 'Documentation of property condition before, during, and after work performed by ' + (isNbd ? 'No Big Deal Home Solutions' : _b.legalName) + '. Photos tagged with location, damage type, and severity where applicable.',
        }
      : {
          headline: 'The story of your project, in pictures',
          body: 'A walkthrough of how the property looked before we started, the work as it happened, and the finished result.',
        };

    const stats = [
      { label: 'Before', value: String(beforeShaped.length), sub: 'pre-work' },
      { label: 'During', value: String(duringShaped.length), sub: 'in progress' },
      { label: 'After',  value: String(afterShaped.length),  sub: 'completed' },
    ];

    // ── D-6: the document as a function of options ────────────────
    const O = _reportOptions(mode, opts.options);

    // Ordered section list. This is what replaced the template's three fixed
    // phase blocks: the caller can reorder, retitle, drop a section, or add a
    // note to one, and a future section that is not a phase at all drops in
    // here without touching the template.
    const SECTION_BLURBS = mode === 'adjuster' ? {
      before: 'Photographic documentation of property condition prior to work commencing.',
      during: 'Mid-project documentation of work in progress.',
      after:  'Final-condition documentation post-completion.',
    } : {
      before: 'Photos of the property at the start of the project.',
      during: 'Photos taken while the crew was on the property.',
      after:  'The finished work — what the property looks like now.',
    };
    const notes = opts.notes || {};
    const sectionNotes = notes.sections || {};
    const defaultOrder = ['before', 'during', 'after'];
    const order = Array.isArray(opts.sectionOrder) && opts.sectionOrder.length
      ? opts.sectionOrder.filter((id) => defaultOrder.indexOf(id) >= 0)
      : defaultOrder;
    const byId = { before: beforeShaped, during: duringShaped, after: afterShaped };
    const TITLES = { before: 'Before', during: 'During', after: 'After' };

    const sections = order
      .filter((id) => (opts.disabledSections || []).indexOf(id) < 0)
      .map((id) => ({
        id,
        title: (opts.sectionTitles && opts.sectionTitles[id]) || TITLES[id],
        blurb: SECTION_BLURBS[id],
        note: sectionNotes[id] || '',
        photos: byId[id] || [],
      }))
      .filter((s) => s.photos.length);

    _numberSections(sections, O.numbering);

    const toc = sections.map((s) => ({ title: s.title, count: s.photos.length }));

    // Property / claim grid — the fields an adjuster looks for first and the
    // homeowner report has never carried. Only non-empty rows are sent, so a
    // lead with nothing filled in renders no grid rather than a wall of dashes.
    const meta = [
      { label: 'Property', value: lead.address || '' },
      { label: 'Claim No.', value: lead.claimNumber || '' },
      { label: 'Carrier', value: lead.insCarrier || lead.insuranceCarrier || lead.carrier || '' }, // insCarrier is what the lead form writes
      { label: 'Date of Loss', value: lead.dateOfLoss || '' },
      { label: 'Damage Type', value: lead.damageType || '' },
      { label: 'Photos', value: String((allPhotos || []).length) },
    ].filter((r) => r.value);

    const payload = {
      // Cover (shared partial)
      preparedFor,
      preparedBy,
      projectMeta,
      coverEyebrow: (opts.coverEyebrow != null ? opts.coverEyebrow
        : (mode === 'adjuster' ? 'Photo Report · Adjuster Dossier' : 'Photo Report · Project Story')),
      coverTagline: (opts.coverTagline != null ? opts.coverTagline
        : (mode === 'adjuster' ? 'Documented.<br>Defensible.' : 'The work,<br>in pictures.')),
      coverSub: (opts.coverSub != null ? opts.coverSub
        : (mode === 'adjuster'
          ? 'Comprehensive photographic record of property condition prior to, during, and following the scope of work performed.'
          : 'A visual walkthrough of your roof — what we found, what we did, and what it looks like now.')),
      // A 'minimal' cover is the same page without the hero image, so the
      // template never has to branch — the decision is made once, here.
      coverPhoto: O.cover === 'minimal' ? null : (opts.coverPhotoUrl
        || (beforeShaped[0] && beforeShaped[0].url) || (afterShaped[0] && afterShaped[0].url) || null),
      coverCaption: O.cover === 'minimal' ? null
        : (opts.coverCaption != null ? opts.coverCaption
          : ((beforeShaped[0] && beforeShaped[0].location) || null)),
      docNumber: reportNumber,
      // Body
      summary,
      stats,
      mode,
      opts: O,
      notes: {
        coverLetter: notes.coverLetter || '',
        summaryBody: notes.summaryBody || '',
        closing: notes.closing || '',
      },
      sections,
      toc,
      meta,
      pairs: O.showPairs ? pairs : [],
      hasAnnotated: sections.some((s) => s.photos.some((p) => p.annotated)),
    };

    const fn = window._httpsCallable(window._functions, 'renderPdf');
    const slug = (name || 'photos').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
    const modeTag = mode === 'adjuster' ? 'Adjuster' : 'Homeowner';
    // Tenant-resolved prefix. functions/render-pdf.js takes this string
    // VERBATIM, so it is what lands on the homeowner's disk.
    const _base = modeTag + 'Photos-' + slug + '-' + new Date().toISOString().split('T')[0] + '.pdf';
    const filename = window._tenantFileName ? await window._tenantFileName(_base) : _base;

    const r = await fn({ template: 'photoReport', payload, filename });
    const data = r && r.data;
    if (!data || !data.ok || !data.url) throw new Error('Render returned no URL');

    // File it on the lead. This module contained ZERO Firestore writes: a photo
    // report existed only as a browser tab and a file in the rep's Downloads
    // folder. Nothing recorded that it was made, so there was no history, no
    // re-download, and nothing for a share link to ever point at — while every
    // other document producer in the CRM files a row
    // (customer-signed-doc-upload.js:49 is the canonical shape).
    //
    // Deliberately after the viewer opens and never fatal: the PDF already
    // rendered and is in front of the rep, so a rules denial on the documents
    // subcollection must not turn a finished report into an error.
    _fileReportOnLead(lead.id, {
      name: data.filename || filename,
      url: data.url,
      storagePath: data.path || '',
      bytes: data.bytes || 0,
      mode: mode,
      reportNumber: reportNumber,
      options: O,
    });

    if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
      window.NBDDocViewer.open({
        url: data.url,
        title: modeTag + ' Photo Report — ' + name,
        filename: data.filename || filename,
      });
    } else {
      window.open(data.url, '_blank', 'noopener');
    }
    const ms = data.timing && data.timing.totalMs;
    if (typeof showToast === 'function') {
      showToast(ms ? '✓ Photo report rendered in ' + ms + 'ms' : '✓ Photo report rendered', 'ok');
    }
    return true;
  }

  window.generatePhotoReport = generatePhotoReport;
  // Exposed for smoke + future Playwright coverage. Pure function —
  // takes an array of photo docs, returns up to 8 {location, before,
  // after} pair objects. No DOM, no Firebase, safe to unit-test.
  window._buildPhotoReportPairs = _buildPairs;
  // Same reason: the display-order comparator is pure, so the drag-order
  // contract can be asserted behaviourally instead of by grepping the source.
  window._comparePhotoReportOrder = _comparePhotoReportOrder;
  // D-6 builder internals. All pure, all exported for the same reason as the
  // two above: the option contract, the numbering scheme and the capture-date
  // fallback chain are behaviour worth asserting on directly, rather than
  // grepping the source for the shape of a fix.
  //
  // _reportOptions is the exception (Globals Tranche 3, T3-C): its one runtime
  // consumer, customer-photo-report-picker.js, resolves it through
  // __NBD_CALL_REGISTRY under the public name _photoReportOptions, so it is
  // off window. The guard creates the registry if this lazy bundle is ever
  // the first thing on a page to touch it.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  window.__NBD_CALL_REGISTRY._photoReportOptions = _reportOptions;
  window._numberReportSections = _numberSections;
  window._photoReportDateLabel = _dateLabel;
  window._photoReportTimestampMs = _photoTimestampMs;
  window._photoReportCaption = _captionFor;

})();
