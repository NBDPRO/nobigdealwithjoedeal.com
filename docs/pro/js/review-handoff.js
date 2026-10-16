/**
 * review-handoff.js — the "Job done" hand-off screen (2026-10-16).
 *
 * Joe, at the end of an install or when the final payment lands, turns the
 * phone around: a full-screen card with the homeowner's own roof, before and
 * after, a big QR code for the company's Google review page and an "Open
 * review page" button. The homeowner scans it on their own phone.
 *
 * FTC (16 CFR 465) and Google's review policy: every customer sees the same
 * card. No rating first, no "if you were happy", nothing offered in return,
 * no filtering of who gets it. The card asks for an honest review and says
 * nothing else. Nothing is sent, stamped or marked asked by opening it.
 *
 * WHICH LINK: the rep's own Google review link (users/{uid}.googleReviewUrl,
 * https only), else NBD's (https://g.page/r/CXzIjLwvtRPdEBM/review, the link
 * the automatic review email uses, functions/review-ask-auto-logic.js) for the
 * NBD tenant, else ReviewEngine.getReviewLink() for another company (its own
 * Settings link or brand integration). A tenant with nothing set gets no QR
 * and a line saying where to add the link: never NBD's link.
 *
 * WHICH PHOTOS: the same pick the review email makes (#2491,
 * functions/review-ask-photo.js pickPhotos / eligiblePhotos), run here on the
 * lead's own CRM photos as this user may read them: this lead only, the
 * lead's tenant, not deleted or hidden, not another job of the lead, images
 * only, the "shared with the homeowner" set when any is shared; then a Before
 * + After pair (same location first), else the latest After, else none. The
 * photos are shown from their CRM links on Joe's own screen; nothing is made
 * public. tests/review-handoff-2026-10-16.test.js keeps the pick identical to
 * the email's.
 *
 * WHERE: customer.html "Job done" (a lead at Install Done or later), Field's
 * action bar, the Field lead screen and the end-of-day wrap-up. Any element
 * with data-rh-open + data-lead-id opens it (one document-level listener).
 * The QR comes from qr-code.js (drawn in the page; no third-party URL).
 */
(function (root) {
  'use strict';

  var NBD_REVIEW_URL = 'https://g.page/r/CXzIjLwvtRPdEBM/review';
  // Install Done and every stage after it (paid-in-full rule's won keys, plus
  // the aliases the CRM still writes for a closed job).
  var DONE_STAGES = {
    install_complete: 1, final_photos: 1, deductible_collected: 1, collections: 1,
    final_payment: 1, closed: 1, warranty_claim: 1, complete: 1, completed: 1,
    closed_won: 1, 'closed-won': 1, won: 1,
  };
  var NOT_IMAGE = /\.(mp4|mov|m4v|webm|avi|pdf|heic|heif)$/i;

  // ── pure: kept in step with functions/review-ask-photo.js ───────────────
  function ms(t) {
    if (!t) return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (t instanceof Date) return t.getTime();
    var d = Date.parse(t);
    return isFinite(d) ? d : 0;
  }
  function takenMs(p) { return ms(p.capturedAt) || ms(p.createdAt) || ms(p.uploadedAt) || 0; }
  function phaseOf(p) {
    var ph = String((p && p.phase) || '').trim().toLowerCase();
    if (ph === 'before' || ph === 'after') return ph;
    if (ph) return null;
    var tags = Array.isArray(p && p.tags) ? p.tags.map(function (t) { return String(t).toLowerCase(); }) : [];
    if (tags.indexOf('after') !== -1 || tags.indexOf('completed_work') !== -1) return 'after';
    if (tags.indexOf('before') !== -1) return 'before';
    return null;
  }
  function objectPathOf(p) {
    if (!p) return '';
    var orig = typeof p.originalStoragePath === 'string' ? p.originalStoragePath : '';
    if (p.isAnnotated === true && orig) return orig;
    return (typeof p.storagePath === 'string' && p.storagePath) || (typeof p.path === 'string' && p.path) || '';
  }
  /** The address to show: the clean original of an annotated photo, else the photo. https only. */
  function displayUrlOf(p) {
    if (!p) return '';
    var u = (p.isAnnotated === true && typeof p.originalUrl === 'string' && p.originalUrl) ? p.originalUrl : p.url;
    return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : '';
  }
  /** This lead's own photos the card may use (the email's rule, minus the Storage read). */
  function eligiblePhotos(lead, leadId, jobId, photos) {
    var l = lead || {};
    var lid = String(leadId || '');
    if (!lid) return [];
    var list = (Array.isArray(photos) ? photos : []).filter(function (p) {
      if (!p || typeof p !== 'object') return false;
      if (p.leadId !== lid) return false;
      var sameTenant = (typeof p.userId === 'string' && p.userId && p.userId === l.userId) ||
        (typeof l.companyId === 'string' && l.companyId && p.companyId === l.companyId);
      if (!sameTenant) return false;
      if (p.deleted === true || p.deletedAt || p.hidden === true) return false;
      if (jobId && p.jobId && p.jobId !== jobId) return false;
      var path = objectPathOf(p);
      if (!path || NOT_IMAGE.test(path)) return false;
      if (/^(video|application)\//i.test(String(p.mimeType || p.contentType || p.type || ''))) return false;
      if (!displayUrlOf(p)) return false;
      return true;
    });
    if (list.some(function (p) { return p.sharedWithHomeowner === true; })) list = list.filter(function (p) { return p.sharedWithHomeowner === true; });
    return list;
  }
  function normLoc(p) {
    return String((p && (p.location || (p.inferredLocation && p.inferredLocation.label))) || '')
      .toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ');
  }
  /** { kind: 'pair', before, after } | { kind: 'single', after } | null — review-ask-photo.js pickPhotos. */
  function pickPhotos(photos) {
    var list = Array.isArray(photos) ? photos : [];
    var byTime = function (a, b) { return takenMs(a) - takenMs(b) || String(a.id || '').localeCompare(String(b.id || '')); };
    var befores = list.filter(function (p) { return phaseOf(p) === 'before'; }).sort(byTime);
    var afters = list.filter(function (p) { return phaseOf(p) === 'after'; }).sort(byTime).reverse();
    if (!afters.length) return null;
    if (!befores.length) return { kind: 'single', after: afters[0] };
    for (var i = 0; i < afters.length; i++) {
      var k = normLoc(afters[i]);
      if (!k) continue;
      for (var j = 0; j < befores.length; j++) if (normLoc(befores[j]) === k) return { kind: 'pair', before: befores[j], after: afters[i] };
    }
    return { kind: 'pair', before: befores[0], after: afters[0] };
  }
  function stageKeyOf(lead) {
    var raw = String((lead && (lead._stageKey || lead.stage)) || '').trim().toLowerCase();
    return raw.replace(/\s+/g, '_');
  }
  /** Install Done or later: when the hand-off belongs on screen. */
  function isJobDone(lead) {
    if (!lead || lead.deleted === true) return false;
    if (DONE_STAGES[stageKeyOf(lead)]) return true;
    return !!(ms(lead.installCompletedAt) || ms(lead.completedAt));
  }
  function safeHttps(u) { return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim().slice(0, 500) : ''; }
  /** rep's own → NBD's (NBD tenant) → the tenant's own (ReviewEngine) → ''. */
  function pickReviewUrl(repUrl, isNbd, tenantUrl) {
    return safeHttps(repUrl) || (isNbd ? NBD_REVIEW_URL : '') || (isNbd ? '' : safeTenantUrl(tenantUrl));
  }
  // ReviewEngine's last-ditch fallback is a maps search: not a review page, so no QR for it.
  function safeTenantUrl(u) {
    var s = safeHttps(u);
    return s && !/^https:\/\/www\.google\.com\/maps\/search\//i.test(s) ? s : '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function firstName(lead) {
    return String((lead && (lead.firstName || lead.name)) || '').trim().split(/\s+/)[0].slice(0, 40);
  }
  function brandName() {
    try { var b = typeof root._brand === 'function' ? root._brand() || {} : {}; if (b.legalName || b.displayName) return b.legalName || b.displayName; } catch (e) { /* fall through */ }
    return isNbdTenant() ? 'No Big Deal Home Solutions' : '';
  }
  function isNbdTenant() { return typeof root._isNbdPlatformTenant === 'function' && root._isNbdPlatformTenant() === true; }

  /** The card's HTML. Pure. pick: pickPhotos() result; qrSvg: '' = no link on file. */
  function cardHtml(o) {
    var name = firstName(o.lead);
    var word = o.word === 'project' ? 'project' : 'roof';
    var h = '<div class="rh-card" role="document">' +
      '<button type="button" class="rh-close" data-rh-close aria-label="Close">&times;</button>' +
      '<h2 class="rh-title" id="rhTitle">' + (name ? 'Thank you, ' + esc(name) + '!' : 'Thank you!') + '</h2>';
    var pk = o.pick;
    if (pk && pk.kind === 'pair') {
      h += '<p class="rh-sub">Here\'s your ' + word + ', before and after.</p><div class="rh-photos rh-pair">' +
        '<figure><img src="' + esc(displayUrlOf(pk.before)) + '" alt="Your ' + word + ' before the work" loading="eager" decoding="async"><figcaption>Before</figcaption></figure>' +
        '<figure><img src="' + esc(displayUrlOf(pk.after)) + '" alt="Your ' + word + ' after the work" loading="eager" decoding="async"><figcaption>After</figcaption></figure></div>';
    } else if (pk && pk.kind === 'single') {
      h += '<p class="rh-sub">Here\'s your finished ' + word + '.</p><div class="rh-photos rh-single">' +
        '<figure><img src="' + esc(displayUrlOf(pk.after)) + '" alt="Your finished ' + word + '" loading="eager" decoding="async"></figure></div>';
    } else if (o.loadingPhotos) {
      h += '<p class="rh-sub rh-muted">Loading your photos…</p>';
    }
    var co = o.company ? esc(o.company) : 'us';
    if (o.qrSvg && o.url) {
      h += '<p class="rh-ask">Would you leave ' + co + ' a Google review? Honest feedback, whatever it is, helps your neighbors pick a contractor.</p>' +
        '<div class="rh-qr" aria-describedby="rhQrHelp">' + o.qrSvg + '</div>' +
        '<p class="rh-help" id="rhQrHelp">Point your phone camera at the code.</p>' +
        '<a class="rh-open" href="' + esc(o.url) + '" target="_blank" rel="noopener noreferrer">Open review page</a>';
    } else if (o.loadingLink) {
      h += '<p class="rh-help">Loading the review link…</p>';
    } else {
      h += '<p class="rh-help">No Google review link is set for this account yet. Add it in Settings (Google review link) and this card will show the code.</p>';
    }
    return h + '<button type="button" class="rh-done" data-rh-close>Done</button></div>';
  }

  // ── browser ─────────────────────────────────────────────────────────────
  var state = { el: null, leadId: null, lastFocus: null, seq: 0 };

  function leadFor(id) {
    var cur = root._currentLead;
    if (cur && (cur.id === id || root._customerId === id)) return Object.assign({ id: id }, cur);
    var list = Array.isArray(root._leads) ? root._leads : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function wordFor(lead) {
    var s = [lead && lead.jobType, lead && lead.serviceType, lead && lead.service, lead && lead.projectType].filter(function (x) { return typeof x === 'string'; }).join(' ');
    if (/roof/i.test(s)) return 'roof';
    if (/\b(siding|gutter|window|door|deck|paint|fence|interior|remodel|soffit|fascia)/i.test(s)) return 'project';
    return 'roof';
  }
  function photoScopes(leadId, lead) {
    var W = root;
    if (typeof W._photoQueryScopes === 'function' && W._currentLead && (W._customerId === leadId || W._currentLead.id === leadId)) return W._photoQueryScopes(leadId);
    var claims = W._userClaims || {};
    var uid = W._user && W._user.uid;
    var teamReader = ['company_admin', 'manager', 'viewer'].indexOf(claims.role || '') !== -1 && !!claims.companyId &&
      lead && lead.userId && uid && lead.userId !== uid;
    return teamReader ? [W.where('leadId', '==', leadId)] : [W.where('leadId', '==', leadId), W.where('userId', '==', uid)];
  }
  function loadPhotos(leadId, lead) {
    var W = root;
    if (!W.db || typeof W.getDocs !== 'function' || typeof W.query !== 'function' || typeof W.collection !== 'function' || typeof W.where !== 'function') return Promise.resolve([]);
    var q;
    try { q = W.query.apply(null, [W.collection(W.db, 'photos')].concat(photoScopes(leadId, lead))); } catch (e) { return Promise.resolve([]); }
    return Promise.resolve(W.getDocs(q)).then(function (snap) {
      var out = [];
      if (snap && typeof snap.forEach === 'function') snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
      return out;
    }, function () { return []; });
  }
  function loadReviewUrl() {
    var W = root;
    var nbd = isNbdTenant();
    var repP = Promise.resolve('');
    try {
      if (W.db && W._user && typeof W.getDoc === 'function' && typeof W.doc === 'function') {
        repP = Promise.resolve(W.getDoc(W.doc(W.db, 'users', W._user.uid))).then(function (s) {
          var d = s && typeof s.exists === 'function' && s.exists() ? (s.data() || {}) : {};
          return d.googleReviewUrl || '';
        }, function () { return ''; });
      }
    } catch (e) { repP = Promise.resolve(''); }
    return repP.then(function (rep) {
      if (safeHttps(rep) || nbd) return pickReviewUrl(rep, nbd, '');
      var RE = W.ReviewEngine;
      if (!RE || typeof RE.getReviewLink !== 'function') return '';
      return Promise.resolve(RE.getReviewLink()).then(function (t) { return pickReviewUrl('', false, t); }, function () { return ''; });
    });
  }
  function qrFor(url) {
    var Q = root.NBDQr;
    if (!url || !Q || typeof Q.svg !== 'function') return '';
    try { return Q.svg(url, { ecl: 'M', border: 4, label: 'QR code for the Google review page' }); } catch (e) { return ''; }
  }

  function paint(o) {
    if (!state.el) return;
    state.el.innerHTML = cardHtml(o);
  }
  function close() {
    if (!state.el) return;
    if (state.el.parentNode) state.el.parentNode.removeChild(state.el);
    state.el = null; state.leadId = null; state.seq++;
    document.documentElement.classList.remove('rh-open-html');
    document.removeEventListener('keydown', onKey, true);
    try { if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus(); } catch (e) { /* gone */ }
  }
  function onKey(ev) {
    if (!state.el) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    var f = state.el.querySelectorAll('button, a[href]');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  function open(leadId) {
    var id = String(leadId || root._customerId || '');
    if (!id) return false;
    var lead = leadFor(id);
    if (!lead) { if (typeof root.showToast === 'function') root.showToast('Customer not loaded yet. Try again in a moment.', 'error'); return false; }
    if (state.el) close();
    state.lastFocus = document.activeElement;
    var el = document.createElement('div');
    el.className = 'rh-overlay';
    el.id = 'rhOverlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'rhTitle');
    document.body.appendChild(el);
    document.documentElement.classList.add('rh-open-html');
    state.el = el; state.leadId = id;
    var seq = ++state.seq;
    var view = { lead: lead, word: wordFor(lead), company: brandName(), pick: null, qrSvg: '', url: '', loadingPhotos: true, loadingLink: true };
    paint(view);
    document.addEventListener('keydown', onKey, true);
    var btn = el.querySelector('.rh-done');
    if (btn) btn.focus();
    loadReviewUrl().then(function (url) {
      if (seq !== state.seq) return;
      view.url = url; view.qrSvg = qrFor(url); view.loadingLink = false; paint(view);
    }, function () { if (seq === state.seq) { view.loadingLink = false; paint(view); } });
    loadPhotos(id, lead).then(function (photos) {
      if (seq !== state.seq) return;
      view.pick = pickPhotos(eligiblePhotos(lead, id, lead.activeJobId || null, photos));
      view.loadingPhotos = false; paint(view);
    });
    return true;
  }

  /** Show / hide the customer page's "Job done" button for the loaded lead. */
  function syncCustomerButton() {
    var b = document.getElementById('jobDoneHandoffBtn');
    if (!b) return;
    var lead = root._currentLead;
    var show = !!lead && isJobDone(lead);
    b.hidden = !show;
    if (show) b.setAttribute('data-lead-id', String(root._customerId || lead.id || ''));
  }

  if (typeof document !== 'undefined' && root && !root.NBDReviewHandoff) {
    document.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-rh-open], [data-rh-close]') : null;
      if (!t) {
        if (state.el && ev.target === state.el) close();     // a tap on the dim backdrop
        return;
      }
      ev.preventDefault();
      if (t.hasAttribute('data-rh-close')) { close(); return; }
      open(t.getAttribute('data-lead-id') || '');
    });
    // customer.html: the button follows the loaded lead's stage (a stage change
    // on the page shows it without a reload). One cheap read of a global.
    if (document.getElementById('jobDoneHandoffBtn')) setInterval(syncCustomerButton, 1500);
  }

  var api = {
    open: open, close: close, isJobDone: isJobDone, syncCustomerButton: syncCustomerButton,
    _pickPhotos: pickPhotos, _eligiblePhotos: eligiblePhotos, _pickReviewUrl: pickReviewUrl, _cardHtml: cardHtml,
    _displayUrlOf: displayUrlOf, NBD_REVIEW_URL: NBD_REVIEW_URL,
  };
  if (root) root.NBDReviewHandoff = root.NBDReviewHandoff || api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
