/**
 * photo-review.js — auth + Firestore + photo subscription for the
 * rep-facing Review Sprint UI at /pro/photo-review.
 *
 * Extracted from an inline <script type="module"> in
 * photo-review.html because the strict ** CSP at firebase.json:44
 * (which applies to /pro/photo-review — no route override exists)
 * blocks inline scripts. Result: Firebase never initialized, page
 * hung on "Loading..." forever. Mirror of the same fix the
 * customer.html FIXME at firebase.json:76 calls for.
 */
import { initializeApp, getApps } from "/assets/vendor/firebase/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "/assets/vendor/firebase/10.12.2/firebase-app-check.js";
import { getAuth, onAuthStateChanged } from "/assets/vendor/firebase/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, onSnapshot, query, where, orderBy, updateDoc, deleteDoc, serverTimestamp, writeBatch } from "/assets/vendor/firebase/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "/assets/vendor/firebase/10.12.2/firebase-functions.js";
import { connectEmulatorsIfLocal } from "../nbd-emulator-connect.js"; // Audit #3: localhost-only, no-op in prod

// NEW-D32: this file shipped a FABRICATED firebaseConfig (apiKey/senderId
// 555556015293 / appId that exist nowhere else in the repo). Firebase Auth
// keys its persisted session by apiKey, so getAuth() on the wrong key NEVER
// sees the signed-in user — onAuthStateChanged fired null and the auth gate
// bounced every visitor to /pro/login even with a live session. The page has
// been unreachable since extraction. Config below mirrors the canonical one
// in nbd-auth.js (single source of truth); getApps() guard matches
// ds-firebase-sync.js's pattern.
const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
try {
  if (typeof window.__NBD_APP_CHECK_KEY === 'string' && window.__NBD_APP_CHECK_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(window.__NBD_APP_CHECK_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
} catch (_) {}

const auth = getAuth(app);
const db = getFirestore(app);
// One functions instance bound to THIS app, shared by the emulator hookup
// and the portal-link minter below — a bare getFunctions() would target the
// default app and, under emulator QA, prod (CRM-SECURITY-AUDIT-2026-08-02
// open question 5). Audit #3: localhost-only, no-op in prod.
const fns = getFunctions(app);
await connectEmulatorsIfLocal({ auth, db, functions: fns });
window.db = db;

// ── State ──
const state = {
  leadId: null,
  lead: null,
  photos: [],          // sorted, current view
  photosById: new Map(),
  filter: 'all',
  selected: new Set(), // photoIds
  unsub: null,
  user: null,
};

// ── URL params ──
const params = new URLSearchParams(location.search);
state.leadId = params.get('lead') || params.get('id');

// ── Auth gate ──
onAuthStateChanged(auth, (user) => {
  if (!user) { location.href = '/pro/login.html'; return; }
  state.user = user;
  if (!state.leadId) {
    document.getElementById('prBody').innerHTML = '<div class="pr-loading">No lead specified. Open from a customer page.</div>';
    return;
  }
  document.getElementById('prBack').href = '/pro/customer.html?id=' + encodeURIComponent(state.leadId);
  loadLead().then(subscribeToPhotos).catch(err => {
    console.error(err);
    document.getElementById('prBody').innerHTML = '<div class="pr-loading">Couldn\'t load this lead. <a href="/pro/dashboard.html">Back to dashboard</a></div>';
  });
});

async function loadLead() {
  const snap = await getDoc(doc(db, 'leads', state.leadId));
  if (!snap.exists()) throw new Error('Lead not found');
  state.lead = { id: snap.id, ...snap.data() };
  const name = ((state.lead.firstName || '') + ' ' + (state.lead.lastName || '')).trim() || state.lead.name || 'Customer';
  document.getElementById('prLeadName').textContent = name;
}

function subscribeToPhotos() {
  if (state.unsub) state.unsub();
  const q = query(
    collection(db, 'photos'),
    where('leadId', '==', state.leadId),
    where('userId', '==', state.user.uid)
  );
  state.unsub = onSnapshot(q, (snap) => {
    const photos = [];
    snap.forEach(d => photos.push({ id: d.id, ...d.data() }));
    photos.sort((a, b) => {
      const ta = a.uploadedAt?.toMillis?.() || a.uploadedAt?.seconds * 1000 || 0;
      const tb = b.uploadedAt?.toMillis?.() || b.uploadedAt?.seconds * 1000 || 0;
      return ta - tb;
    });
    state.photos = photos;
    state.photosById.clear();
    for (const p of photos) state.photosById.set(p.id, p);
    render();
  }, err => {
    console.error('photo subscription failed:', err);
    document.getElementById('prBody').innerHTML = '<div class="pr-loading">Couldn\'t load photos: ' + err.message + '</div>';
  });
}

// ── Helpers ──
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function thumbUrl(photo) {
  return photo?.urls?.thumb || photo?.urls?.med || photo?.url || '';
}
function fullUrl(photo) {
  return photo?.urls?.full || photo?.urls?.med || photo?.url || '';
}
function phaseOf(photo) {
  return photo.phase || (photo.aiSuggestion && photo.aiSuggestion.phase) || null;
}
function locationOf(photo) {
  return photo.location || (photo.inferredLocation && photo.inferredLocation.label) || '';
}
// ── /photos.damageType canon ──────────────────────────────────────
// This page and functions/photo-vision.js write lowercase snake_case;
// photo-editor.js and the customer-page quick-edit popup wrote Title
// Case, and the customer.html bulk bar wrote kebab-case. Same docs, four
// spellings. docs/pro/js/photo-damage-types.js folds them; it is a
// classic script loaded before this module in photo-review.html, so the
// global is present by the time this module evaluates. The fallbacks
// keep the page usable (unlabeled, unfolded) if it ever is not.
function dmgNorm(v) {
  const D = window.NBD_PHOTO_DAMAGE;
  return D ? D.normalize(v) : String(v == null ? '' : v).trim().toLowerCase();
}
function dmgLabel(v) {
  const D = window.NBD_PHOTO_DAMAGE;
  return D ? D.label(v) : String(v == null ? '' : v);
}

function damageOf(photo) {
  return dmgNorm(photo.damageType || (photo.aiSuggestion && photo.aiSuggestion.damageType));
}
function severityOf(photo) {
  return photo.severity || (photo.aiSuggestion && photo.aiSuggestion.severity) || '';
}
function captionOf(photo) {
  return photo.caption || (photo.aiSuggestion && photo.aiSuggestion.caption) || '';
}
function isReviewed(photo) {
  // A photo is "reviewed" once it has a confirmed phase (rep accepted
  // OR rep entered manually). Caption/damage/severity are nice-to-have
  // but phase is the bucket signal.
  //
  // 2026-10-04: burst capture stamps phase from the lead's stage
  // (phaseSource 'stage') so photos land in the right Before/During/After
  // bucket straight away — but nobody has LOOKED at them yet. Such a photo
  // counts as reviewed only once the rep has given it a location.
  if (photo.phaseSource === 'stage') return !!(photo.phase && photo.location);
  return !!photo.phase;
}
function chipState(photo, field) {
  // 'accepted'   = photo.<field> == aiSuggestion.<field>
  // 'overridden' = photo.<field> set, AI suggested differently
  // 'suggested'  = AI suggested but rep hasn't accepted
  // 'empty'      = no value either way
  let ai = photo.aiSuggestion ? photo.aiSuggestion[field] : null;
  let manual;
  if      (field === 'phase')      manual = photo.phase;
  else if (field === 'location')   manual = photo.location;
  // Both sides folded: a rep who picked 'Hail' in photo-editor.js over an
  // AI 'hail' suggestion was scored 'overridden' for agreeing with it.
  else if (field === 'damageType') { manual = dmgNorm(photo.damageType); ai = dmgNorm(ai); }
  else if (field === 'severity')   manual = photo.severity;
  if (manual && ai && manual === ai) return 'accepted';
  if (manual && ai && manual !== ai) return 'overridden';
  if (manual)                        return 'overridden'; // user-set, no AI
  if (ai)                            return 'suggested';
  return 'empty';
}
function chipValue(photo, field) {
  if      (field === 'phase')      return photo.phase      || (photo.aiSuggestion && photo.aiSuggestion.phase);
  else if (field === 'location')   return photo.location   || (photo.inferredLocation && photo.inferredLocation.label);
  else if (field === 'damageType') return dmgNorm(photo.damageType || (photo.aiSuggestion && photo.aiSuggestion.damageType));
  else if (field === 'severity')   return photo.severity   || (photo.aiSuggestion && photo.aiSuggestion.severity);
  return '';
}
function confLevel(photo) {
  const c = photo.aiSuggestion?.confidence;
  if (typeof c !== 'number') return 'none';
  if (c >= 0.8) return 'high';
  if (c >= 0.5) return 'medium';
  return 'low';
}

// Field option dictionaries — used by picker + bulk bar
const FIELD_OPTIONS = {
  phase:      [['Before','Before'],['During','During'],['After','After']],
  // Sourced from the shared canon so this picker, photo-editor.js and the
  // customer-page quick-edit offer ONE vocabulary. Literal fallback covers
  // the shared script failing to load.
  damageType: (window.NBD_PHOTO_DAMAGE && window.NBD_PHOTO_DAMAGE.options())
    || [['hail','Hail'],['wind','Wind'],['wear','Wear'],['granular_loss','Granular loss'],['leak','Leak'],['none','No damage'],['other','Other']],
  severity:   [['minor','Minor'],['moderate','Moderate'],['severe','Severe']],
  // Audit 2026-06-10: every tile renders a "+ Location" chip, but with no
  // entry here its picker opened with zero options — the chip could clear or
  // accept an AI guess, never SET a location. Mirrors QUICK_LOCATIONS in
  // photo-engine.js (the camera tagging flow) so both surfaces share one
  // taxonomy.
  location:   [['Front Slope','Front Slope'],['Back Slope','Back Slope'],['Left Slope','Left Slope'],['Right Slope','Right Slope'],['Ridge','Ridge'],['Valley','Valley'],['Eave','Eave'],['Gutter','Gutter'],['Chimney','Chimney'],['Interior','Interior']],
};
const FIELD_TITLE = {
  phase: 'Phase', damageType: 'Damage type', severity: 'Severity', location: 'Location'
};

// ── Render ──
function render() {
  // counts for filter bar
  const counts = { all: state.photos.length, Before: 0, During: 0, After: 0, unsorted: 0 };
  for (const p of state.photos) {
    const ph = phaseOf(p);
    if (ph === 'Before' || ph === 'During' || ph === 'After') counts[ph]++;
    else counts.unsorted++;
  }
  document.getElementById('cnt-all').textContent       = counts.all;
  document.getElementById('cnt-Before').textContent    = counts.Before;
  document.getElementById('cnt-During').textContent    = counts.During;
  document.getElementById('cnt-After').textContent     = counts.After;
  document.getElementById('cnt-unsorted').textContent  = counts.unsorted;

  // reviewed count
  const reviewed = state.photos.filter(isReviewed).length;
  document.getElementById('prCounter').innerHTML = '<strong>' + reviewed + '</strong>/<span id="prTotal">' + state.photos.length + '</span> reviewed';
  const generateBtn = document.getElementById('prGenerateBtn');
  generateBtn.disabled = state.photos.length === 0;
  generateBtn.onclick = () => {
    // Phase 5: hand off to customer.html with a #photo-report hash so
    // it opens the Homeowner-vs-Adjuster picker automatically.
    location.href = '/pro/customer.html?id=' + encodeURIComponent(state.leadId) + '#photo-report';
  };

  // Group filter logic
  const filteredPhotos = state.photos.filter(p => {
    if (state.filter === 'all') return true;
    if (state.filter === 'unsorted') return !phaseOf(p);
    return phaseOf(p) === state.filter;
  });

  if (filteredPhotos.length === 0) {
    document.getElementById('prBody').innerHTML = '<div class="pr-empty"><strong>No photos here</strong>'
      + (state.filter === 'all'
          ? 'Upload photos from the customer page to start sorting.'
          : 'Try a different filter — there are ' + state.photos.length + ' photos in total.')
      + '</div>';
    return;
  }

  // Group by phase (preserve sort within group = time order from state.photos)
  const groups = { Before: [], During: [], After: [], unsorted: [] };
  for (const p of filteredPhotos) {
    const ph = phaseOf(p);
    if (ph === 'Before' || ph === 'During' || ph === 'After') groups[ph].push(p);
    else groups.unsorted.push(p);
  }
  // Within each group, sort by inferred location cardinal: N → NE → E → SE → S → SW → W → NW
  const CARDINAL_ORDER = ['N','NE','E','SE','S','SW','W','NW'];
  const cardinalRank = (p) => {
    const c = p.inferredLocation && p.inferredLocation.cardinal;
    const i = CARDINAL_ORDER.indexOf(c);
    return i < 0 ? 999 : i;
  };
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => cardinalRank(a) - cardinalRank(b));
  }

  const groupOrder = state.filter === 'all'
    ? ['unsorted','Before','During','After']      // surface unsorted first when looking at everything
    : (state.filter === 'unsorted' ? ['unsorted'] : [state.filter]);

  const sections = groupOrder
    .filter(k => groups[k].length > 0)
    .map(k => {
      const label = k === 'unsorted' ? 'NEEDS REVIEW' : k.toUpperCase();
      const tilesHtml = groups[k].map(renderTile).join('');
      return (
        '<section class="pr-group" data-phase="' + k + '">' +
          '<div class="pr-group-head">' +
            '<span class="pr-group-label">' + label + '</span>' +
            '<span class="pr-group-count">' + groups[k].length + ' photos</span>' +
          '</div>' +
          '<div class="pr-grid">' + tilesHtml + '</div>' +
        '</section>'
      );
    }).join('');

  document.getElementById('prBody').innerHTML = sections;
}

function renderTile(photo) {
  const cap = captionOf(photo);
  const capState = photo.caption ? 'rep' : (photo.aiSuggestion?.caption ? 'ai' : 'empty');
  const capText = cap || 'No caption yet.';
  const conf = confLevel(photo);
  const isSelected = state.selected.has(photo.id);
  const pendingAI = !photo.aiSuggestion;

  const chip = (field, value, state) => {
    const labelMap = FIELD_OPTIONS[field];
    let display = value || (field === 'phase' ? '+ Phase'
                          : field === 'damageType' ? '+ Damage'
                          : field === 'severity' ? '+ Severity'
                          : '+ Location');
    if (value && labelMap) {
      const found = labelMap.find(o => o[0] === value);
      if (found) display = found[1];
    }
    return '<button class="pr-chip" data-field="' + field + '" data-photo-id="' + photo.id + '" data-state="' + state + '">' + esc(display) + '</button>';
  };

  return (
    '<article class="pr-tile' + (isSelected ? ' pr-selected' : '') + (pendingAI ? ' pr-tile-pending' : '') + '" data-photo-id="' + photo.id + '">' +
      '<div class="pr-tile-imgwrap" data-tile-img data-photo-id="' + photo.id + '">' +
        '<img src="' + esc(thumbUrl(photo)) + '" alt="" loading="lazy" decoding="async">' +
        '<div class="pr-tile-conf" data-level="' + conf + '" title="AI confidence: ' + (photo.aiSuggestion?.confidence?.toFixed?.(2) || 'pending') + '"><span class="pr-tile-conf-dot"></span></div>' +
        '<div class="pr-tile-check">✓</div>' +
      '</div>' +
      '<div class="pr-tile-body">' +
        '<div class="pr-tile-chips">' +
          chip('phase',      chipValue(photo, 'phase'),      chipState(photo, 'phase')) +
          chip('location',   chipValue(photo, 'location'),   chipState(photo, 'location')) +
          chip('damageType', chipValue(photo, 'damageType'), chipState(photo, 'damageType')) +
          chip('severity',   chipValue(photo, 'severity'),   chipState(photo, 'severity')) +
        '</div>' +
        '<div class="pr-tile-caption" data-state="' + capState + '">' + esc(capText) + '</div>' +
      '</div>' +
    '</article>'
  );
}

// ── Filter bar wiring ──
document.getElementById('prFilterBar').addEventListener('click', (e) => {
  const btn = e.target.closest('.pr-filter');
  if (!btn) return;
  document.querySelectorAll('.pr-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.filter = btn.dataset.filter;
  render();
});

// ── Tile interactions (delegated) ──
const body = document.getElementById('prBody');

let longPressTimer = null;
let longPressFired = false;
const LONG_PRESS_MS = 450;

body.addEventListener('pointerdown', (e) => {
  longPressFired = false;
  const chip = e.target.closest('.pr-chip');
  const imgWrap = e.target.closest('[data-tile-img]');
  if (!chip && !imgWrap) return;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    if (chip) {
      const photoId = chip.dataset.photoId;
      const field = chip.dataset.field;
      openPicker(field, photoId);
    } else if (imgWrap) {
      openLightbox(imgWrap.dataset.photoId);
    }
  }, LONG_PRESS_MS);
});
body.addEventListener('pointerup', () => { clearTimeout(longPressTimer); });
body.addEventListener('pointercancel', () => { clearTimeout(longPressTimer); });
body.addEventListener('pointermove', () => { clearTimeout(longPressTimer); });

body.addEventListener('click', (e) => {
  if (longPressFired) { longPressFired = false; return; }
  const chip = e.target.closest('.pr-chip');
  if (chip) {
    e.preventDefault();
    e.stopPropagation();
    const photoId = chip.dataset.photoId;
    const field = chip.dataset.field;
    handleChipTap(photoId, field);
    return;
  }
  const imgWrap = e.target.closest('[data-tile-img]');
  if (imgWrap) {
    e.preventDefault();
    const photoId = imgWrap.dataset.photoId;
    toggleSelect(photoId);
  }
});

async function handleChipTap(photoId, field) {
  const photo = state.photosById.get(photoId);
  if (!photo) return;
  const stateNow = chipState(photo, field);
  if (stateNow === 'suggested') {
    // Accept the AI suggestion
    const value = photo.aiSuggestion[field];
    await updatePhotoField(photoId, field, value);
    showToast('Accepted ' + FIELD_TITLE[field] + ': ' + (field === 'damageType' ? dmgLabel(value) : value));
  } else if (stateNow === 'empty') {
    // No suggestion — open picker
    openPicker(field, photoId);
  } else {
    // Already accepted/overridden — long-press to change (info toast)
    showToast('Long-press to change ' + FIELD_TITLE[field]);
  }
}

async function updatePhotoField(photoId, field, value) {
  try {
    const patch = {};
    // Normalize on write. `null` is the picker's explicit clear sentinel and
    // must survive as null, so only fold real values.
    patch[field] = (field === 'damageType' && value != null) ? dmgNorm(value) : value;
    // A phase the rep sets here is a confirmed one (2026-10-04): it replaces
    // the phase photo-engine stamped from the lead's stage at capture.
    if (field === 'phase') patch.phaseSource = value ? 'review' : null;
    patch.updatedAt = serverTimestamp();
    await updateDoc(doc(db, 'photos', photoId), patch);
  } catch (e) {
    console.warn('updatePhotoField failed:', e.message);
    showToast('Save failed — ' + e.message);
  }
}

// ── Selection ──
function toggleSelect(photoId) {
  if (state.selected.has(photoId)) state.selected.delete(photoId);
  else state.selected.add(photoId);
  updateSelectionUI();
}
function clearSelection() {
  state.selected.clear();
  updateSelectionUI();
}
function updateSelectionUI() {
  const count = state.selected.size;
  document.querySelectorAll('.pr-tile').forEach(t => {
    t.classList.toggle('pr-selected', state.selected.has(t.dataset.photoId));
  });
  const bar = document.getElementById('prBulkBar');
  document.getElementById('prBulkCount').textContent = count + ' selected';
  bar.dataset.open = count > 0 ? 'true' : 'false';
}

document.getElementById('prBulkClear').addEventListener('click', clearSelection);
document.getElementById('prBulkDelete').addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  // Routed through nbdConfirm like the other 61 destructive guards. This one
  // sat in docs/pro/js/pages/, which tests/pwa-confirm-guard.test.js did not
  // scan until 2026-09-03 — so the bulk photo delete the guard was written to
  // protect was the one site it could not see.
  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _ask('Delete ' + state.selected.size + ' photo' + (state.selected.size === 1 ? '' : 's') + '? This can\'t be undone.'))) return;
  const ids = Array.from(state.selected);
  // Batch delete (Firestore caps batches at 500; we're well under)
  try {
    const batch = writeBatch(db);
    for (const id of ids) batch.delete(doc(db, 'photos', id));
    await batch.commit();
    clearSelection();
    showToast('Deleted ' + ids.length + ' photos');
  } catch (e) {
    showToast('Delete failed: ' + e.message);
  }
});
// NEW-D31 (2026-09-02): PortalLinkHelpers.copyForLead resolves its URL
// minter as window.CustomerPortal.mintUrl (customer.html only) or
// window._mintPortalUrl (dashboard-api.js, dashboard only). Neither is
// loaded on this page, so every bulk Share ended with "Shared N photos"
// followed immediately by "Couldn't copy link: Portal module not loaded"
// — a red toast on a successful action. Provide the dashboard's minter
// here, byte-for-byte the same contract as dashboard-api.js: mint a
// fresh, revocable 30-day portal token via the createPortalToken
// callable and return the /pro/portal.html?token= URL. Side-effect free;
// copyForLead owns the clipboard + recordShare.
window._mintPortalUrl = async function (leadId) {
  if (!leadId) throw new Error('No lead selected');
  const call = httpsCallable(fns, 'createPortalToken');
  const res = await call({ leadId, ttlDays: 30 });
  const token = res && res.data && res.data.token;
  if (!token) throw new Error('No token returned');
  return location.origin + '/pro/portal.html?token=' + encodeURIComponent(token);
};

// Phase 5: flip sharedWithHomeowner=true on selected photos so they
// appear in the homeowner's portal view (getHomeownerPortalView already
// filters by this flag). Then offer to copy/SMS the portal link via the
// existing PortalLinkHelpers — one button = share-these-photos.
document.getElementById('prBulkShare').addEventListener('click', async () => {
  if (state.selected.size === 0) return;
  const ids = Array.from(state.selected);
  try {
    const batch = writeBatch(db);
    for (const id of ids) batch.update(doc(db, 'photos', id), {
      sharedWithHomeowner: true,
      updatedAt: serverTimestamp()
    });
    await batch.commit();
    showToast('Shared ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + ' with the homeowner');
    clearSelection();
    // Open the portal-link share flow if the helper module is loaded.
    if (window.PortalLinkHelpers
        && typeof window.PortalLinkHelpers.copyForLead === 'function'
        && state.lead) {
      // Best-effort copy. The rep can also tap SMS/email from the
      // customer page if they want different channels.
      window.PortalLinkHelpers.copyForLead(state.lead);
    }
  } catch (e) {
    showToast('Share failed: ' + e.message);
  }
});

document.querySelectorAll('[data-bulk-field]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (state.selected.size === 0) return;
    openPicker(btn.dataset.bulkField, null /* bulk-mode */);
  });
});

// ── Picker overlay ──
const picker = document.getElementById('prPicker');
let pickerContext = { field: null, photoId: null };

function openPicker(field, photoId) {
  pickerContext = { field, photoId };
  const title = (photoId ? '' : (state.selected.size + ' photos · ')) + (FIELD_TITLE[field] || field);
  document.getElementById('prPickerTitle').textContent = title;

  const opts = FIELD_OPTIONS[field] || [];
  const photo = photoId ? state.photosById.get(photoId) : null;
  const current = photo ? chipValue(photo, field) : null;
  const html = opts.map(([val, label]) => {
    const cls = (current === val) ? ' pr-picker-opt-current' : '';
    return '<button class="pr-picker-opt' + cls + '" data-pick="' + esc(val) + '">' + esc(label) + '</button>';
  }).join('');
  document.getElementById('prPickerOptions').innerHTML = html;
  picker.dataset.open = 'true';
}
function closePicker() {
  picker.dataset.open = 'false';
  pickerContext = { field: null, photoId: null };
}
picker.addEventListener('click', (e) => {
  if (e.target === picker) { closePicker(); return; }
  const opt = e.target.closest('[data-pick]');
  if (!opt) return;
  const value = opt.dataset.pick;
  applyPickerChoice(value);
});
document.getElementById('prPickerClear').addEventListener('click', () => applyPickerChoice(null));

async function applyPickerChoice(value) {
  const { field, photoId } = pickerContext;
  closePicker();
  if (!field) return;
  const ids = photoId ? [photoId] : Array.from(state.selected);
  if (ids.length === 0) return;
  // Batch update for bulk
  try {
    const batch = writeBatch(db);
    const writeValue = (field === 'damageType' && value != null) ? dmgNorm(value) : value;
    for (const id of ids) {
      const patch = {};
      patch[field] = writeValue;
      patch.updatedAt = serverTimestamp();
      batch.update(doc(db, 'photos', id), patch);
    }
    await batch.commit();
    if (ids.length > 1) {
      showToast('Applied ' + FIELD_TITLE[field] + ' to ' + ids.length + ' photos');
      clearSelection();
    } else {
      showToast('Saved ' + FIELD_TITLE[field]);
    }
  } catch (e) {
    showToast('Save failed: ' + e.message);
  }
}

// ── Lasso (desktop) ──
const lasso = document.getElementById('prLasso');
let lassoStart = null;
let lassoActive = false;
function isDesktop() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}
body.addEventListener('pointerdown', (e) => {
  if (!isDesktop()) return;
  if (e.button !== 0) return;
  // Only start lasso if click was NOT on a tile or chip
  if (e.target.closest('.pr-tile, .pr-chip, .pr-filter, .pr-bulk-btn, .pr-bulk-bar, .pr-picker, .pr-lightbox')) return;
  lassoStart = { x: e.clientX, y: e.clientY + window.scrollY };
  lassoActive = false;
});
body.addEventListener('pointermove', (e) => {
  if (!lassoStart) return;
  const x1 = lassoStart.x, y1 = lassoStart.y;
  const x2 = e.clientX, y2 = e.clientY + window.scrollY;
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  if (!lassoActive && (dx > 6 || dy > 6)) {
    lassoActive = true;
    lasso.style.display = 'block';
  }
  if (!lassoActive) return;
  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  lasso.style.left = left + 'px';
  lasso.style.top  = top  + 'px';
  lasso.style.width  = w + 'px';
  lasso.style.height = h + 'px';
});
window.addEventListener('pointerup', () => {
  if (!lassoStart) return;
  if (lassoActive) {
    // Find overlapping tiles
    const lr = lasso.getBoundingClientRect();
    const lT = lr.top + window.scrollY, lB = lr.bottom + window.scrollY;
    const lL = lr.left, lR = lr.right;
    document.querySelectorAll('.pr-tile').forEach(t => {
      const r = t.getBoundingClientRect();
      const tT = r.top + window.scrollY, tB = r.bottom + window.scrollY;
      if (r.right < lL || r.left > lR || tB < lT || tT > lB) return;
      state.selected.add(t.dataset.photoId);
    });
    updateSelectionUI();
  }
  lasso.style.display = 'none';
  lassoStart = null;
  lassoActive = false;
});

// ── Lightbox ──
const lightbox = document.getElementById('prLightbox');
const lightboxImg = document.getElementById('prLightboxImg');
function openLightbox(photoId) {
  const photo = state.photosById.get(photoId);
  if (!photo) return;
  lightboxImg.src = fullUrl(photo);
  lightbox.dataset.open = 'true';
}
function closeLightbox() {
  lightbox.dataset.open = 'false';
  lightboxImg.src = '';
}
document.getElementById('prLightboxClose').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });

// ── Keyboard ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (lightbox.dataset.open === 'true') { closeLightbox(); return; }
    if (picker.dataset.open === 'true')   { closePicker(); return; }
    if (state.selected.size > 0)          { clearSelection(); return; }
  }
});

// ── Toast ──
// 2026-07-19 consolidation: delegates to the shared /pro/js/toast.js module
// (dashboard contract, bottom-right stack, loaded by photo-review.html
// before this module). Replaces the old #prToast bottom-center pill.
function showToast(msg, type) {
  window.showToast(msg, type);
}

// ── AI cap awareness ──
window.addEventListener('nbd:ai-classify-skipped', (e) => {
  const reason = e.detail && e.detail.reason;
  const msg = reason === 'lead-cap'
    ? 'AI cap reached for this lead ($10) — chips you set still save.'
    : reason === 'daily-cap'
    ? 'Daily AI cap reached (100/day) — chips you set still save.'
    : 'Monthly AI cap reached — chips you set still save.';
  showToast(msg);
});
