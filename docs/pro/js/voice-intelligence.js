/**
 * docs/pro/js/voice-intelligence.js — client module for Voice Intel.
 *
 * ES module. No window.* pollution, no inline handlers. Loaded into
 * lead-detail.html via <script type="module"> so the per-page CSP
 * can drop 'unsafe-inline' (M1 direction).
 *
 * Public surface (for C4 UI integration):
 *   initVoiceIntel({ leadId, containerEl, auth, db, storage })
 *     → cleanup()
 *
 * Data flow:
 *   - resolves the caller's companyId + consent mode from Firestore
 *   - subscribes to leads/{leadId}/recordings via onSnapshot
 *   - exposes recordBlob() + uploadFromFile() helpers
 *   - pushes UI state updates through a small reducer
 *
 * Shipped in 2 chunks:
 *   C3a (this commit) — data layer + uploader + consent resolver.
 *                       Everything that can be smoke-tested without
 *                       DOM. No rendering.
 *   C3b (next)        — recording controls, consent modal,
 *                       recording-list UI.
 */

import {
  collection, query, orderBy, onSnapshot, doc, getDoc, where
} from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';
import {
  ref as storageRef, uploadBytesResumable, getDownloadURL
} from '/assets/vendor/firebase/12.19.0/firebase-storage.js';

// ─── Consent modes (must match companies/{id}.recordingConsentMode) ─
export const CONSENT_MODES = Object.freeze({
  ONE_PARTY:           'one_party',
  TWO_PARTY_ATTESTED:  'two_party_attested',
  TWO_PARTY_VERBAL:    'two_party_verbal'
});

// Max upload size mirrors storage.rules + voice-intelligence.js
// server-side cap so the client fails fast rather than sending a
// 200MB request only to get a 403.
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

// Allowed content types. Mirror the isAudioType() rule in
// storage.rules. MediaRecorder on Chrome/Firefox emits audio/webm;
// Safari emits audio/mp4. User-uploaded files can be any of the rest.
export const ALLOWED_AUDIO_MIME = Object.freeze([
  'audio/webm', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
  'audio/m4a', 'audio/x-m4a', 'audio/ogg', 'audio/wav', 'audio/aac'
]);

// ─── ID generator — 12 char crockford-style, crypto-random ──────
// Used for recordingId in the Storage path + Firestore doc. Opaque,
// URL-safe, no collisions within a user's lifetime at any sane rate.
export function newRecordingId() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] & 31];
  return out;
}

// ─── Company / consent-mode resolver ────────────────────────────
// The server-side pipeline (voice-intelligence.js::getCompanyContext)
// reads the same doc. We keep the client-side read as a UX nicety —
// knowing the mode BEFORE recording starts lets us show the right
// modal. The SERVER is still authoritative: if someone tampers with
// this and sends a recording without consent, the pipeline's
// checkVerbalConsent still runs and quarantines.
export async function resolveCompanyConsentMode({ db, uid }) {
  let companyId = uid;
  let consentMode = CONSENT_MODES.TWO_PARTY_ATTESTED; // safest default
  try {
    const userSnap = await getDoc(doc(db, 'users', uid));
    if (userSnap.exists()) {
      const u = userSnap.data();
      if (u.companyId) companyId = u.companyId;
    }
  } catch (_) { /* fall through */ }
  try {
    const coSnap = await getDoc(doc(db, 'companies', companyId));
    if (coSnap.exists()) {
      const c = coSnap.data();
      if (typeof c.recordingConsentMode === 'string') {
        // Accept only known values; unknown string → fall back to
        // safe default rather than trusting a misconfigured doc.
        const m = c.recordingConsentMode;
        if (m === CONSENT_MODES.ONE_PARTY
         || m === CONSENT_MODES.TWO_PARTY_ATTESTED
         || m === CONSENT_MODES.TWO_PARTY_VERBAL) {
          consentMode = m;
        }
      }
    }
  } catch (_) { /* fall through */ }
  return { companyId, consentMode };
}

// ─── Uploader ──────────────────────────────────────────────────
// Uploads a Blob to audio/{uid}/{leadId}/{recordingId}.{ext} using
// uploadBytesResumable so flaky mobile connections resume cleanly.
//
// onProgress({ bytesUploaded, totalBytes, percent }) fires
// repeatedly. Returns a Promise that resolves to { path, downloadURL }
// on success and rejects with a typed error on failure.
export function uploadAudioBlob({
  storage, uid, leadId, recordingId, blob, onProgress, onStateChange
}) {
  if (!(blob instanceof Blob)) {
    return Promise.reject(new VoiceClientError('client-bad-blob',
      'uploadAudioBlob requires a Blob'));
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    return Promise.reject(new VoiceClientError('client-too-large',
      'Audio is ' + Math.round(blob.size / 1024 / 1024) + 'MB; cap is ' +
      Math.round(MAX_AUDIO_BYTES / 1024 / 1024) + 'MB'));
  }
  const contentType = blob.type || 'audio/webm';
  if (!ALLOWED_AUDIO_MIME.some(m => contentType.startsWith(m))) {
    return Promise.reject(new VoiceClientError('client-bad-mime',
      'Unsupported content type: ' + contentType));
  }

  const ext = mimeToExt(contentType);
  const path = 'audio/' + uid + '/' + leadId + '/' + recordingId + '.' + ext;
  const r = storageRef(storage, path);
  const task = uploadBytesResumable(r, blob, {
    contentType,
    // Custom metadata stamped onto the Storage object. The server
    // trigger reads name + contentType + size from the event; this
    // is belt-and-suspenders context for any future ops script.
    customMetadata: {
      uid, leadId, recordingId, clientVersion: '1'
    }
  });

  return new Promise((resolve, reject) => {
    task.on('state_changed',
      (snap) => {
        const total = snap.totalBytes || 0;
        const done  = snap.bytesTransferred || 0;
        const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
        try {
          onProgress && onProgress({
            bytesUploaded: done, totalBytes: total, percent: pct
          });
          onStateChange && onStateChange(snap.state); // 'running','paused','success'
        } catch (_) { /* listener errors never break the upload */ }
      },
      (err) => {
        reject(new VoiceClientError('client-upload-failed',
          (err && err.code) ? err.code : String(err && err.message || err)));
      },
      async () => {
        let downloadURL = null;
        try { downloadURL = await getDownloadURL(task.snapshot.ref); } catch (_) {}
        resolve({ path, downloadURL, bytes: blob.size, contentType });
      }
    );
  });
}

// ─── Recording-list subscription ────────────────────────────────
// Returns an unsubscribe function. `onChange` fires with the full
// array of recording docs (newest first) every time Firestore pushes
// an update, including transitions between
// transcribing → analyzing → complete. UI just re-renders.
//
// IMPORTANT — query MUST include `where('userId','==', uid)`:
// firestore.rules:142-150 evaluates `isOwner(resource.data.userId)`
// per doc. For Firestore to allow a list query, the query has to
// constrain to docs the rules can prove are readable. Without the
// where filter, even an EMPTY collection returns "Missing or
// insufficient permissions" — exactly the error users were hitting
// on every customer page that hadn't recorded a call yet. (The
// agent-investigated fix from W120 P0 + the user-reported screenshot
// of customer.html → Voice Intel: "Could not load recordings:
// Missing or insufficient permissions.")
//
// `uid` is required. The caller (mountVoiceIntel) passes user.uid.
export function subscribeToRecordings({ db, leadId, uid, onChange, onError }) {
  if (!uid) {
    // Fail fast with a typed error instead of silently rejecting
    // the query — the caller should never invoke this without a uid.
    const err = new VoiceClientError('client-no-uid',
      'subscribeToRecordings requires uid for the userId-scoped query.');
    try { onError && onError(err); } catch (_) {}
    return () => {};
  }
  const q = query(
    collection(db, 'leads', leadId, 'recordings'),
    where('userId', '==', uid),
    orderBy('recordedAt', 'desc')
  );
  return onSnapshot(q,
    (snap) => {
      const docs = [];
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
      try { onChange && onChange(docs); } catch (_) {}
    },
    (err) => {
      try { onError && onError(err); } catch (_) {}
    }
  );
}

// ─── Helpers ────────────────────────────────────────────────────
export class VoiceClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.isVoiceClientError = true;
  }
}

export function mimeToExt(contentType) {
  const t = String(contentType || '').split(';')[0].trim().toLowerCase();
  switch (t) {
    case 'audio/webm':               return 'webm';
    case 'audio/mp4': case 'audio/m4a': case 'audio/x-m4a': return 'm4a';
    case 'audio/mpeg': case 'audio/mp3': return 'mp3';
    case 'audio/ogg':                return 'ogg';
    case 'audio/wav':                return 'wav';
    case 'audio/aac':                return 'aac';
    default:                         return 'webm';
  }
}

// ─── DOM helpers ────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtSec(n) {
  const s = Math.max(0, Math.floor(Number(n) || 0));
  const mm = Math.floor(s / 60), ss = s % 60;
  return mm + ':' + String(ss).padStart(2, '0');
}
function fmtCost(c) {
  const d = (Number(c) || 0) / 100;
  return '$' + d.toFixed(d < 1 ? 3 : 2);
}

// ─── Recorder state machine ─────────────────────────────────────
// Wraps MediaRecorder with a clean event API. States:
//   'idle' → 'requesting' → 'recording' → 'stopping' → 'done'
// onEvent({type, ...}) is the only way state leaves the recorder.
// Errors are their own event type so the UI can show a message
// without having to decode MediaRecorder's opaque DOMException.
function createRecorder({ onEvent }) {
  let stream = null, rec = null, chunks = [];
  let startedAt = 0, tickTimer = 0, state = 'idle';

  async function start() {
    if (state !== 'idle' && state !== 'done') return;
    state = 'requesting';
    onEvent({ type: 'state', state });
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      state = 'idle';
      onEvent({ type: 'error',
        code: 'mic-denied',
        message: e && e.name === 'NotAllowedError'
          ? 'Microphone access was denied. Enable it in your browser settings.'
          : ('Could not access microphone: ' + (e && e.message || e)) });
      return;
    }
    // Pick the best supported MIME type. Safari lacks webm opus but
    // speaks mp4/aac. Let the browser pick with no hint if neither
    // explicit type is supported.
    const preferred = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/mp4;codecs=mp4a'
    ];
    let mimeType = '';
    for (const t of preferred) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) {
        mimeType = t; break;
      }
    }
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType })
                     : new MediaRecorder(stream);
    } catch (e) {
      releaseStream();
      state = 'idle';
      onEvent({ type: 'error', code: 'recorder-init-failed',
        message: 'MediaRecorder failed to initialize: ' + (e && e.message || e) });
      return;
    }
    chunks = [];
    rec.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    });
    rec.addEventListener('error', (ev) => {
      onEvent({ type: 'error', code: 'recorder-error',
        message: 'Recorder error: ' + (ev.error && ev.error.message || 'unknown') });
    });
    rec.addEventListener('stop', () => {
      state = 'done';
      clearInterval(tickTimer); tickTimer = 0;
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
      const duration = Math.round((Date.now() - startedAt) / 1000);
      releaseStream();
      onEvent({ type: 'done', blob, duration, mimeType: blob.type });
    });
    rec.start(1000); // fire dataavailable every 1s so no data lost on crash
    state = 'recording'; startedAt = Date.now();
    onEvent({ type: 'state', state, startedAt });
    tickTimer = setInterval(() => {
      onEvent({ type: 'tick', elapsedSec: Math.round((Date.now() - startedAt) / 1000) });
    }, 500);
  }

  function stop() {
    if (state !== 'recording') return;
    state = 'stopping';
    onEvent({ type: 'state', state });
    try { rec && rec.stop(); } catch (_) {}
  }

  function cancel() {
    if (state === 'recording') {
      try { rec && rec.stop(); } catch (_) {}
    }
    releaseStream();
    state = 'idle';
    onEvent({ type: 'state', state });
  }

  function releaseStream() {
    if (stream) {
      try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      stream = null;
    }
  }

  return { start, stop, cancel, getState: () => state };
}

// ─── Consent modal ──────────────────────────────────────────────
// Three paths based on companies/{id}.recordingConsentMode:
//   one_party           → no modal, proceed.
//   two_party_attested  → checkbox: "All parties have consented".
//   two_party_verbal    → instruction page: "Before you start, ask
//                         every party out loud and record their
//                         'yes' answer in the first 20 seconds.
//                         The system will verify."
//
// Returns a Promise<boolean> — true = proceed, false = user cancelled.
function showConsentModal(consentMode) {
  return new Promise((resolve) => {
    if (consentMode === CONSENT_MODES.ONE_PARTY) { resolve(true); return; }

    const overlay = document.createElement('div');
    overlay.className = 'nbd-voice-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const heading = consentMode === CONSENT_MODES.TWO_PARTY_VERBAL
      ? 'Two-party consent — verbal'
      : 'Two-party consent — attestation';
    const body = consentMode === CONSENT_MODES.TWO_PARTY_VERBAL
      ? 'Your company requires a VERBAL affirmation of consent from every party on this call. ' +
        'Before saying anything else, ask: "I\'m recording this call — do I have your consent?" ' +
        'The system will scan the first 20 seconds of the transcript and quarantine the recording if no affirmation is found.'
      : 'Your company requires that all parties have consented to being recorded. ' +
        'Confirm below that you have obtained consent from everyone on the call.';
    const checkboxRow = consentMode === CONSENT_MODES.TWO_PARTY_ATTESTED
      ? '<label class="nbd-voice-consent-check">' +
        '<input type="checkbox" id="nbd-voice-consent-check">' +
        ' I confirm all parties have consented to being recorded.' +
        '</label>'
      : '';

    overlay.innerHTML =
      '<div class="nbd-voice-modal">' +
        '<h2>' + escHtml(heading) + '</h2>' +
        '<p>' + escHtml(body) + '</p>' +
        checkboxRow +
        '<div class="nbd-voice-modal-actions">' +
          '<button type="button" data-act="cancel">Cancel</button>' +
          '<button type="button" data-act="ok" disabled>Start recording</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    const okBtn    = overlay.querySelector('[data-act="ok"]');
    const cancelBtn= overlay.querySelector('[data-act="cancel"]');
    const chk      = overlay.querySelector('#nbd-voice-consent-check');
    if (chk) {
      chk.addEventListener('change', () => { okBtn.disabled = !chk.checked; });
    } else {
      okBtn.disabled = false; // verbal mode: button live immediately
    }
    function close(result) {
      overlay.remove();
      resolve(result);
    }
    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false); // click outside = cancel
    });
    // Initial focus on the primary action for keyboard users.
    (chk || okBtn).focus();
  });
}

// ─── Recording-list renderer ────────────────────────────────────
function renderRecordingList(listEl, docs) {
  if (!listEl) return;
  if (!docs || docs.length === 0) {
    listEl.innerHTML =
      '<div class="nbd-voice-empty">No recordings yet. Record or upload a call to get started.</div>';
    return;
  }
  listEl.innerHTML = docs.map(d => {
    const status = String(d.status || 'unknown');
    const statusLabel = {
      transcribing: 'Transcribing…',
      analyzing:    'Analyzing…',
      complete:     'Complete',
      failed:       'Failed',
      quarantined_consent: 'Quarantined — consent',
      soft_deleted: 'Deleted'
    }[status] || status;
    const recordedAt = d.recordedAt && d.recordedAt.toDate
      ? d.recordedAt.toDate().toLocaleString()
      : (typeof d.recordedAt === 'string' ? d.recordedAt : '');
    const summary = d.summary || {};
    const speakers = Array.isArray(d.speakers) ? d.speakers : [];
    const segments = Array.isArray(d.segments) ? d.segments : [];

    const headerRow =
      '<div class="nbd-voice-item-head">' +
        '<span class="nbd-voice-status nbd-voice-status-' + escHtml(status) + '">' +
          escHtml(statusLabel) +
        '</span>' +
        '<span class="nbd-voice-when">' + escHtml(recordedAt) + '</span>' +
        '<span class="nbd-voice-duration">' + fmtSec(d.audioDurationSec) + '</span>' +
        '<span class="nbd-voice-cost">' + fmtCost(d.costCents) + '</span>' +
        '<span class="nbd-voice-calltype">' + escHtml(d.callType || 'other') + '</span>' +
      '</div>';

    const errorRow = d.statusError
      ? '<div class="nbd-voice-err">' + escHtml(d.statusError) + '</div>'
      : '';

    const summaryBlock = status === 'complete' ? (
      '<div class="nbd-voice-summary">' +
        (summary.overview ? '<p><strong>Overview:</strong> ' + escHtml(summary.overview) + '</p>' : '') +
        fieldList('Damage noted',  summary.damageNoted) +
        fieldList('Objections',    summary.objections) +
        commitmentList(summary.commitments) +
        fieldList('Next actions',  summary.nextActions) +
        insuranceBlock(summary.insuranceDetails) +
        fieldList('Red flags',     summary.redFlags, 'red') +
        speakerBlock(speakers) +
      '</div>'
    ) : '';

    const transcriptBlock = (status === 'complete' && segments.length > 0) ? (
      '<details class="nbd-voice-transcript">' +
        '<summary>Transcript</summary>' +
        '<div class="nbd-voice-segments">' +
          segments.map(s =>
            '<div class="nbd-voice-seg">' +
              '<span class="nbd-voice-seg-t">' + fmtSec(s.start) + '</span> ' +
              '<span class="nbd-voice-seg-s">' + escHtml(s.speaker || '') + '</span> ' +
              escHtml(s.text) +
            '</div>').join('') +
        '</div>' +
      '</details>'
    ) : '';

    return '<div class="nbd-voice-item" data-rec-id="' + escHtml(d.id) + '">' +
      headerRow + errorRow + summaryBlock + transcriptBlock +
      '</div>';
  }).join('');
}
function fieldList(label, items, kind) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const cls = kind === 'red' ? ' nbd-voice-red' : '';
  return '<div class="nbd-voice-list' + cls + '">' +
    '<strong>' + escHtml(label) + ':</strong>' +
    '<ul>' + items.map(x => '<li>' + escHtml(x) + '</li>').join('') + '</ul>' +
    '</div>';
}
function commitmentList(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return '<div class="nbd-voice-list"><strong>Commitments:</strong><ul>' +
    items.map(c => '<li>' +
      '<em>' + escHtml(c.who || '?') + '</em>: ' +
      escHtml(c.what || '') +
      (c.when ? ' <span class="nbd-voice-when-inline">(' + escHtml(c.when) + ')</span>' : '') +
    '</li>').join('') +
    '</ul></div>';
}
function insuranceBlock(ins) {
  if (!ins) return '';
  const parts = [
    ins.carrier     && 'Carrier: '     + ins.carrier,
    ins.claimNumber && 'Claim #: '     + ins.claimNumber,
    ins.adjuster    && 'Adjuster: '    + ins.adjuster,
    ins.deductible  && 'Deductible: '  + ins.deductible
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return '<div class="nbd-voice-list"><strong>Insurance:</strong><ul>' +
    parts.map(p => '<li>' + escHtml(p) + '</li>').join('') +
    '</ul></div>';
}
function speakerBlock(speakers) {
  if (!speakers.length) return '';
  return '<div class="nbd-voice-list"><strong>Speakers:</strong><ul>' +
    speakers.map(s =>
      '<li>' + escHtml(s.label) + ' — ' + escHtml(s.role) +
      (typeof s.confidence === 'number'
        ? ' <span class="nbd-voice-conf">(conf ' + Math.round(s.confidence * 100) + '%)</span>'
        : '') +
      '</li>').join('') +
    '</ul></div>';
}

// ─── Main entry point ───────────────────────────────────────────
// Wires everything together. Returns { cleanup } so the host page
// can tear down the Firestore listener + any in-progress recorder
// state when the tab unmounts.
export function initVoiceIntel({
  leadId, containerEl, auth, db, storage
}) {
  if (!leadId || !containerEl || !auth || !db || !storage) {
    throw new VoiceClientError('client-init-bad-args',
      'initVoiceIntel requires { leadId, containerEl, auth, db, storage }');
  }

  const user = auth.currentUser;
  if (!user) {
    containerEl.innerHTML =
      '<div class="nbd-voice-err">Sign in required to use Voice Intelligence.</div>';
    return { cleanup() {} };
  }

  // C5: feature-flag gate. Reads feature_flags/_default.voice_intelligence_enabled
  // + the per-uid override feature_flags/{uid}.voice_intelligence_enabled
  // (same shape as F9 feature flags for AI usage). Off → the tab
  // renders a placeholder and the rest of the module stays dormant.
  //
  // Default: false. Ops flips the flag on in Firestore when the
  // feature is ready for a given company / cohort.
  // Mutable closure so the async feature-flag branch can install
  // the real cleanup handle once the UI mounts. Caller's
  // cleanup() call fires whatever's installed at that moment —
  // no-op before mount, real teardown after.
  let realCleanup = null;

  isVoiceIntelEnabled({ db, uid: user.uid }).then((enabled) => {
    if (enabled) {
      const instance = mountVoiceIntel({
        leadId, containerEl, auth, db, storage, user
      });
      realCleanup = instance && instance.cleanup;
    } else {
      containerEl.innerHTML =
        '<div class="nbd-voice-empty">' +
        'Voice Intelligence is coming soon to your workspace. ' +
        'Ask ops to enable the voice_intelligence_enabled feature flag for your account.' +
        '</div>';
    }
  }).catch(() => {
    // Fail-CLOSED: an error reading the flag doc leaves the feature
    // OFF. Opening the feature on a Firestore hiccup would surprise
    // users; keeping it closed is the boring safe choice.
    containerEl.innerHTML =
      '<div class="nbd-voice-err">Could not check feature availability. Reload the page.</div>';
  });

  return {
    cleanup() {
      try { realCleanup && realCleanup(); } catch (_) {}
    }
  };
}

async function isVoiceIntelEnabled({ db, uid }) {
  // Per-uid override wins over the default.
  try {
    const own = await getDoc(doc(db, 'feature_flags', uid));
    if (own.exists()) {
      const v = own.data().voice_intelligence_enabled;
      if (typeof v === 'boolean') return v;
    }
  } catch (_) {}
  try {
    const def = await getDoc(doc(db, 'feature_flags', '_default'));
    if (def.exists()) {
      return def.data().voice_intelligence_enabled === true;
    }
  } catch (_) {}
  return false;
}

// Everything below here is the pre-C5 UI mount logic, moved into
// its own function so the feature-flag gate above can call it.
function mountVoiceIntel({ leadId, containerEl, auth, db, storage, user }) {

  // Skeleton DOM — no inline handlers, all wired via addEventListener.
  containerEl.innerHTML =
    '<div class="nbd-voice-root">' +
      '<div class="nbd-voice-controls">' +
        '<button type="button" class="nbd-voice-record" data-act="record">' +
          '<span class="nbd-voice-dot"></span> Record call' +
        '</button>' +
        '<label class="nbd-voice-upload">' +
          '<input type="file" accept="audio/*" style="display:none" data-act="file">' +
          '<span>or upload audio file</span>' +
        '</label>' +
        '<select class="nbd-voice-calltype-sel" data-act="calltype">' +
          '<option value="other">Other</option>' +
          '<option value="inspection">Inspection</option>' +
          '<option value="adjuster">Adjuster</option>' +
          '<option value="close">Close</option>' +
          '<option value="followup">Follow-up</option>' +
        '</select>' +
        '<span class="nbd-voice-timer" data-slot="timer"></span>' +
      '</div>' +
      '<div class="nbd-voice-progress" data-slot="progress"></div>' +
      '<div class="nbd-voice-list" data-slot="list"></div>' +
    '</div>';

  const recordBtn    = containerEl.querySelector('[data-act="record"]');
  const fileInput    = containerEl.querySelector('[data-act="file"]');
  const calltypeSel  = containerEl.querySelector('[data-act="calltype"]');
  const timerSlot    = containerEl.querySelector('[data-slot="timer"]');
  const progressSlot = containerEl.querySelector('[data-slot="progress"]');
  const listSlot     = containerEl.querySelector('[data-slot="list"]');

  let consentMode = CONSENT_MODES.TWO_PARTY_ATTESTED;
  resolveCompanyConsentMode({ db, uid: user.uid }).then((r) => {
    consentMode = r.consentMode;
  }).catch(() => { /* keep safe default */ });

  let activeRecorder = null;
  let currentCallType = 'other';
  calltypeSel.addEventListener('change', (e) => {
    currentCallType = String(e.target.value || 'other');
  });

  async function beginRecording() {
    if (activeRecorder) return;
    const consented = await showConsentModal(consentMode);
    if (!consented) return;
    const rec = createRecorder({
      onEvent: (ev) => {
        if (ev.type === 'tick') {
          timerSlot.textContent = '● ' + fmtSec(ev.elapsedSec);
        } else if (ev.type === 'state') {
          if (ev.state === 'recording') {
            recordBtn.classList.add('is-recording');
            recordBtn.textContent = 'Stop recording';
          } else if (ev.state === 'idle' || ev.state === 'done') {
            recordBtn.classList.remove('is-recording');
            recordBtn.textContent = 'Record call';
            timerSlot.textContent = '';
          }
        } else if (ev.type === 'error') {
          showToast('err', ev.message);
          activeRecorder = null;
        } else if (ev.type === 'done') {
          activeRecorder = null;
          uploadBlob(ev.blob, ev.duration);
        }
      }
    });
    activeRecorder = rec;
    rec.start();
  }

  function stopRecording() {
    if (activeRecorder) activeRecorder.stop();
  }

  async function uploadBlob(blob, durationHint) {
    const recordingId = newRecordingId();
    progressSlot.innerHTML =
      '<div class="nbd-voice-up">Uploading… <span data-slot="pct">0%</span></div>';
    const pctSlot = progressSlot.querySelector('[data-slot="pct"]');
    try {
      await uploadAudioBlob({
        storage, uid: user.uid, leadId, recordingId, blob,
        onProgress: ({ percent }) => {
          if (pctSlot) pctSlot.textContent = percent + '%';
        }
      });
      progressSlot.innerHTML =
        '<div class="nbd-voice-up">Uploaded — processing will start in a few seconds…</div>';
      // The Storage trigger creates the Firestore doc; the
      // onSnapshot listener will surface it in the list.
      setTimeout(() => { progressSlot.innerHTML = ''; }, 8000);
    } catch (e) {
      progressSlot.innerHTML = '';
      showToast('err',
        e && e.isVoiceClientError ? e.message : ('Upload failed: ' + (e && e.message || e)));
    }
  }

  recordBtn.addEventListener('click', () => {
    if (recordBtn.classList.contains('is-recording')) stopRecording();
    else beginRecording();
  });
  fileInput.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    e.target.value = ''; // allow re-upload of same filename
    const consented = await showConsentModal(consentMode);
    if (!consented) return;
    uploadBlob(f, 0);
  });

  const unsubscribe = subscribeToRecordings({
    db, leadId,
    // Pass the rep's uid so the query carries the
    // `where('userId','==', uid)` filter the firestore.rules require.
    // Without this, Firestore rejects the list query with "Missing or
    // insufficient permissions" — even on leads that have NO
    // recordings yet (the empty-state user-reported bug).
    uid: user.uid,
    onChange: (docs) => {
      // callType the user just picked propagates forward on the
      // next upload — we don't back-fill existing docs from here.
      renderRecordingList(listSlot, docs);
    },
    onError: (err) => {
      // Special-case the most likely permission errors with a
      // friendlier hint than Firestore's raw message. This panel
      // is on the customer page that every rep visits daily; a
      // raw "Missing or insufficient permissions" toast is alarming.
      const msg = (err && err.code === 'permission-denied')
        ? 'Voice Intel needs to be enabled for your account. Reach out to support if this persists.'
        : ('Could not load recordings: ' + escHtml(err.message || err));
      listSlot.innerHTML = '<div class="nbd-voice-err">' + msg + '</div>';
    }
  });

  function showToast(kind, msg) {
    const t = document.createElement('div');
    t.className = 'nbd-voice-toast nbd-voice-toast-' + kind;
    t.textContent = msg;
    containerEl.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  return {
    cleanup() {
      try { unsubscribe && unsubscribe(); } catch (_) {}
      try { activeRecorder && activeRecorder.cancel(); } catch (_) {}
    },
    // Exposed for C4 integration — host page can forward the
    // user's callType selection into future recordings.
    getCurrentCallType() { return currentCallType; }
  };
}
