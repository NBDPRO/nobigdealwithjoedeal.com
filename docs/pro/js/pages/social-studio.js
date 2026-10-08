/**
 * pages/social-studio.js — Social Studio (/pro/social.html), 2026-10-04.
 *
 * The CRM's own social media system (replacing Metricool): drafts from
 * finished jobs, "Plan N weeks", approve, a month/week content calendar with
 * per-platform lanes (drag to reschedule on desktop; tap → date picker on
 * phone), the "Ready to post" manual queue, switches, and JSON/CSV export.
 *
 * Data: companies/{companyId}/social_posts (firestore.rules: owner +
 * company_admin only). Lifecycle writes that need the privacy + Kentucky
 * filter go through callables (functions/social-studio.js); the page writes
 * only what the rules let a client write (edit → draft, reschedule, cancel,
 * mark posted, delete, settings).
 *
 * Reels (Reel Studio, 2026-10-04): the Reels tab lives in pages/social-reels.js;
 * a rendered reel lands here as a normal post with format 'reel' (video +
 * hero-frame poster), approved through the same callable.
 *
 * Captions: the server drafts a template caption (always filtered). "Write
 * with AI" asks Claude Haiku 4.5 through the claudeProxy (window.callClaude)
 * using ONLY the post's public facts (town, package, kind) — never the
 * customer — and falls back to the template when the proxy is unavailable.
 * Whatever the AI writes is filtered again at approval.
 */
import { initializeApp, getApps } from "/assets/vendor/firebase/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "/assets/vendor/firebase/10.12.2/firebase-app-check.js";
import { getAuth, onAuthStateChanged } from "/assets/vendor/firebase/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, updateDoc, deleteDoc, setDoc, serverTimestamp, Timestamp, query, limit } from "/assets/vendor/firebase/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "/assets/vendor/firebase/10.12.2/firebase-functions.js";
import { getStorage } from "/assets/vendor/firebase/10.12.2/firebase-storage.js";
import { connectEmulatorsIfLocal, emulatorAppCheckIfLocal } from "../nbd-emulator-connect.js";
import { initReels } from "./social-reels.js?v=2";

const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const _emuAppCheck = await emulatorAppCheckIfLocal(app);
try {
  if (!_emuAppCheck && typeof window.__NBD_APP_CHECK_KEY === 'string' && window.__NBD_APP_CHECK_KEY) {
    window.__NBD_APP_CHECK = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(window.__NBD_APP_CHECK_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
} catch (_) {}
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app);
const storage = getStorage(app);
await connectEmulatorsIfLocal({ auth, db, functions: fns, storage });
window.auth = auth; // claude-proxy.js reads window.auth.currentUser

const S = window.NBDSocialLogic;
const MEDIA_BASE = '/api/social-media';
const AI_MODEL = 'claude-haiku-4-5-20251001';
const AUTO_PLATFORMS = ['facebook', 'instagram', 'gbp'];

const state = {
  uid: null, companyId: null, posts: [], byId: new Map(), settings: { enabled: false, reels: false, platforms: {} },
  tab: 'calendar', view: (window.matchMedia && window.matchMedia('(min-width: 800px)').matches) ? 'month' : 'week',
  anchorMs: Date.now(), hiddenLanes: new Set(), editingId: null, jobs: null, dragId: null,
};

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
let toastTimer = null;
function toast(msg) {
  const t = $('ssToast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
function call(name, data) {
  return httpsCallable(fns, name, { timeout: 300000 })(data || {}).then((r) => r.data);
}
function fmtWhen(v) {
  const t = S.ms(v);
  if (!t) return 'Not scheduled';
  return new Date(t).toLocaleString('en-US', { timeZone: S.TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function safeUrl(u) { return typeof u === 'string' && /^https:\/\/[^\s"<>]+$/.test(u); }
function postRef(id) { return doc(db, 'companies', state.companyId, 'social_posts', id); }
function platLabel(p) { return (S.PLATFORMS[p] && S.PLATFORMS[p].label) || p; }
function composeMessage(p) {
  const cap = String(p.caption || '').trim();
  const tags = (p.hashtags || []).join(' ');
  return tags ? (cap ? cap + '\n\n' + tags : tags) : cap;
}

// ── Auth gate ────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = '/pro/login.html'; return; }
  let claims = {};
  try { claims = (await user.getIdTokenResult()).claims || {}; } catch (_) {}
  const role = String(claims.role || '');
  const companyId = String(claims.companyId || user.uid);
  const allowed = role === 'admin' || (role !== 'viewer' && (companyId === user.uid || role === 'company_admin'));
  if (!allowed) {
    $('ssSub').textContent = 'Owner or company admin only';
    $('ssMain').innerHTML = '<div class="ss-empty">Social Studio is for the company owner or a company admin.</div>';
    return;
  }
  state.uid = user.uid;
  state.companyId = companyId;
  $('ssNewFromJob').disabled = false;
  $('ssPlan').disabled = false;
  subscribe();
  reels.start();
  ['srNew', 'srUpload', 'srAi'].forEach((id) => { if ($(id)) $(id).disabled = false; });
});

function subscribe() {
  onSnapshot(query(collection(db, 'companies', state.companyId, 'social_posts'), limit(2000)), (snap) => {
    const posts = [];
    snap.forEach((d) => posts.push(Object.assign({ id: d.id }, d.data())));
    state.posts = posts;
    state.byId = new Map(posts.map((p) => [p.id, p]));
    render();
    if (state.editingId && state.byId.has(state.editingId)) refreshEditorStatus();
  }, (err) => {
    console.error('[social] posts subscription failed', err);
    $('ssCal').innerHTML = '<div class="ss-empty">Could not load posts: ' + esc(err.message) + '</div>';
  });
  onSnapshot(doc(db, 'companies', state.companyId, 'social_settings', 'config'), (snap) => {
    const d = snap.exists() ? snap.data() : {};
    state.settings = { enabled: d.enabled === true, reels: d.reels === true, platforms: d.platforms || {} };
    renderSettings();
    renderSub();
  }, () => {});
}

// ── Render ───────────────────────────────────────────────────────────────
function renderSub() {
  const scheduled = state.posts.filter((p) => p.status === 'scheduled').length;
  $('ssSub').textContent = (state.settings.enabled ? 'Auto-publish ON' : 'Auto-publish off') + ' · ' + scheduled + ' scheduled';
}

function render() {
  renderSub();
  const drafts = S.needsApproval(state.posts);
  const ready = S.readyQueue(state.posts, Date.now());
  $('ssCountDrafts').textContent = String(drafts.length);
  $('ssCountReady').textContent = String(ready.length);
  renderCalendar();
  $('ssDrafts').innerHTML = drafts.length ? drafts.map(cardHtml).join('') : '<div class="ss-empty">Nothing waiting for approval. Draft one from a job or plan a few weeks.</div>';
  $('ssReady').innerHTML = ready.length ? ready.map(cardHtml).join('') : '<div class="ss-empty">Nothing to post by hand right now.</div>';
  const all = state.posts.slice().sort((a, b) => (S.ms(b.scheduledAt) || S.ms(b.createdAt)) - (S.ms(a.scheduledAt) || S.ms(a.createdAt)));
  $('ssAll').innerHTML = all.length ? all.map(cardHtml).join('') : '<div class="ss-empty">No posts yet.</div>';
}

function isReel(p) { return p && p.format === 'reel' && p.video && p.video.key; }
function thumbsHtml(p) {
  if (isReel(p)) {
    // Reel Studio video: the hero frame as the poster; plays inline on iPhone.
    return '<div class="ss-thumbs"><video class="ss-video ' + (p.video.aspect === '1:1' ? 'sr-a11' : 'sr-a916') + '" controls playsinline preload="none" src="' + esc(MEDIA_BASE + '?k=' + p.video.key) + '"' +
      (p.video.thumbKey ? ' poster="' + esc(MEDIA_BASE + '?k=' + p.video.thumbKey) + '"' : '') + '></video></div>';
  }
  const media = p.media || [];
  if (!media.length) return '';
  return '<div class="ss-thumbs">' + media.map((m) => '<img loading="lazy" alt="" src="' + esc(MEDIA_BASE + '?k=' + m.key) + '">').join('') + '</div>';
}

function cardHtml(p) {
  const st = p.status || 'draft';
  const actions = [];
  actions.push('<button class="ss-btn ss-btn-small" data-act="edit" data-id="' + esc(p.id) + '">Open</button>');
  if (st === 'ready' || (st === 'scheduled' && S.PLATFORMS[p.platform] && !S.PLATFORMS[p.platform].auto)) {
    actions.push('<button class="ss-btn ss-btn-small" data-act="copy" data-id="' + esc(p.id) + '">Copy caption</button>');
    if ((p.media || []).length) actions.push('<button class="ss-btn ss-btn-small" data-act="share" data-id="' + esc(p.id) + '">' + (isReel(p) ? 'Share video' : 'Share photos') + '</button>');
    if (isReel(p)) actions.push('<a class="ss-btn ss-btn-small sr-link" download="nbd-reel.mp4" href="' + esc(MEDIA_BASE + '?k=' + p.video.key) + '">Download MP4</a>');
    actions.push('<button class="ss-btn ss-btn-small ss-btn-primary" data-act="markposted" data-id="' + esc(p.id) + '">Mark posted</button>');
  }
  const err = st === 'failed' && p.publish && p.publish.lastError ? '<div class="ss-err">' + esc(p.publish.lastError) + '</div>' : '';
  const why = st === 'ready' && p.readyReason ? '<div class="ss-warn">' + esc(p.readyReason) + '</div>' : '';
  const link = safeUrl(p.postUrl) ? '<div><a href="' + esc(p.postUrl) + '" target="_blank" rel="noopener">View post</a></div>' : '';
  return '<article class="ss-card" data-post="' + esc(p.id) + '">' +
    '<div class="ss-card-h"><span class="ss-badge">' + esc(platLabel(p.platform)) + '</span>' +
    '<span class="ss-badge st-' + esc(st) + '">' + esc(S.STATUS_LABELS[st] || st) + '</span>' +
    '<span class="ss-badge">' + esc(S.KIND_LABELS[p.kind] || p.kind || '') + '</span>' +
    (isReel(p) ? '<span class="ss-badge">Reel</span>' : '') + (p.aiGenerated ? '<span class="ss-badge sr-ai">AI graphic</span>' : '') +
    '<span class="ss-card-when">' + esc(fmtWhen(p.postedAt || p.scheduledAt)) + '</span></div>' +
    thumbsHtml(p) +
    '<div class="ss-caption">' + esc(p.caption || '') + '</div>' +
    '<div class="ss-tags">' + esc((p.hashtags || []).join(' ')) + '</div>' +
    err + why + link +
    '<div class="ss-card-actions">' + actions.join('') + '</div></article>';
}

function chipHtml(p) {
  const t = S.ms(p.postedAt) || S.ms(p.scheduledAt);
  const time = t ? new Date(t).toLocaleTimeString('en-US', { timeZone: S.TZ, hour: 'numeric', minute: '2-digit' }) : '';
  const draggable = (p.status !== 'posted' && p.status !== 'publishing') ? ' draggable="true"' : '';
  return '<button class="ss-chip st-' + esc(p.status) + '" data-act="edit" data-id="' + esc(p.id) + '"' + draggable +
    ' title="' + esc(platLabel(p.platform) + ' · ' + (S.STATUS_LABELS[p.status] || p.status)) + '">' +
    '<span class="ss-chip-dot"></span><span class="ss-chip-text">' + esc(time + ' ' + (S.KIND_LABELS[p.kind] || '')) + '</span></button>';
}

function renderLaneFilter(lanes) {
  $('ssLaneFilter').innerHTML = lanes.map((l) =>
    '<button class="ss-lane-chip" data-act="lane" data-lane="' + esc(l) + '" aria-pressed="' + (state.hiddenLanes.has(l) ? 'false' : 'true') + '">' + esc(platLabel(l)) + '</button>').join('');
}

function renderCalendar() {
  const lanes = S.lanes(state.posts, ['facebook', 'instagram']);
  renderLaneFilter(lanes);
  const visible = lanes.filter((l) => !state.hiddenLanes.has(l));
  const buckets = S.bucketByDay(state.posts);
  const todayKey = S.ymdKey(Date.now());
  $('ssViewWeek').setAttribute('aria-pressed', String(state.view === 'week'));
  $('ssViewMonth').setAttribute('aria-pressed', String(state.view === 'month'));
  if (state.view === 'month') {
    const p = new Date(state.anchorMs);
    const ym = S.ymdKey(state.anchorMs).split('-').map(Number);
    $('ssCalLabel').textContent = p.toLocaleDateString('en-US', { timeZone: S.TZ, month: 'long', year: 'numeric' });
    const grid = S.monthGrid(ym[0], ym[1]);
    let html = '<div class="ss-month">' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => '<div class="ss-dow">' + d + '</div>').join('');
    grid.forEach((week) => week.forEach((c) => {
      const day = buckets[c.key] || {};
      const items = visible.flatMap((l) => day[l] || []);
      html += '<div class="ss-day' + (c.inMonth ? '' : ' out') + (c.key === todayKey ? ' today' : '') + '" data-day="' + c.key + '">' +
        '<span class="ss-daynum">' + c.day + '</span>' + items.map(chipHtml).join('') + '</div>';
    }));
    $('ssCal').innerHTML = html + '</div>';
  } else {
    const keys = S.weekKeys(state.anchorMs);
    const a = S.parseYmd(keys[0]), b = S.parseYmd(keys[6]);
    $('ssCalLabel').textContent = a.m + '/' + a.d + ' – ' + b.m + '/' + b.d;
    let html = '<div class="ss-week">';
    keys.forEach((k) => {
      const d = S.parseYmd(k);
      const label = new Date(Date.UTC(d.y, d.m - 1, d.d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
      const day = buckets[k] || {};
      html += '<div class="ss-wday' + (k === todayKey ? ' today' : '') + '" data-day="' + k + '"><div class="ss-wday-h">' + esc(label) + '</div>';
      visible.forEach((l) => {
        const items = day[l] || [];
        html += '<div class="ss-lane" data-lane="' + esc(l) + '"><div class="ss-lane-name">' + esc(platLabel(l)) + '</div><div class="ss-lane-items">' +
          (items.length ? items.map(chipHtml).join('') : '') + '</div></div>';
      });
      html += '</div>';
    });
    $('ssCal').innerHTML = html + '</div>';
  }
}

function renderSettings() {
  $('ssEnabled').checked = state.settings.enabled;
  if ($('ssReels')) $('ssReels').checked = state.settings.reels;
  document.querySelectorAll('input[data-platform]').forEach((el) => {
    const v = state.settings.platforms[el.dataset.platform];
    el.checked = v !== false && !(el.dataset.platform === 'gbp' && v !== true);
  });
}

// ── Sheet (bottom drawer) ─────────────────────────────────────────────────
function openSheet(title, html) {
  $('ssSheetTitle').textContent = title;
  $('ssSheetBody').innerHTML = html;
  $('ssSheet').hidden = false;
}
function closeSheet() { $('ssSheet').hidden = true; state.editingId = null; }

function editorHtml(p) {
  const st = p.status;
  const locked = st === 'posted' || st === 'publishing';
  const b = [];
  if (!locked) {
    b.push('<button class="ss-btn" data-act="save" data-id="' + esc(p.id) + '">Save</button>');
    b.push('<button class="ss-btn" data-act="ai" data-id="' + esc(p.id) + '">Write with AI</button>');
    if (st === 'draft' || st === 'failed' || st === 'cancelled') {
      b.push('<button class="ss-btn ss-btn-primary" data-act="approve" data-id="' + esc(p.id) + '">Approve &amp; schedule</button>');
    } else {
      b.push('<button class="ss-btn ss-btn-primary" data-act="move" data-id="' + esc(p.id) + '">Move to this time</button>');
    }
    if (st !== 'cancelled') b.push('<button class="ss-btn" data-act="cancel" data-id="' + esc(p.id) + '">Cancel post</button>');
    b.push('<button class="ss-btn" data-act="markposted" data-id="' + esc(p.id) + '">Mark posted</button>');
    b.push('<button class="ss-btn ss-btn-danger" data-act="delete" data-id="' + esc(p.id) + '">Delete</button>');
  }
  b.push('<button class="ss-btn" data-act="copy" data-id="' + esc(p.id) + '">Copy caption</button>');
  b.push('<button class="ss-btn" data-act="close">Close</button>');
  const when = S.toLocalInput(S.ms(p.scheduledAt)) || S.toLocalInput(Date.now() + 86400000);
  return '<div class="ss-card-h"><span class="ss-badge">' + esc(platLabel(p.platform)) + '</span>' +
    '<span class="ss-badge st-' + esc(st) + '" id="ssEdStatus">' + esc(S.STATUS_LABELS[st] || st) + '</span>' +
    (p.town ? '<span class="ss-badge">' + esc(p.town) + '</span>' : '') + '</div>' +
    thumbsHtml(p) +
    (st === 'failed' && p.publish && p.publish.lastError ? '<div class="ss-err">' + esc(p.publish.lastError) + '</div>' : '') +
    (safeUrl(p.postUrl) ? '<div><a href="' + esc(p.postUrl) + '" target="_blank" rel="noopener">View post</a></div>' : '') +
    '<label class="ss-field"><span>Caption</span><textarea class="ss-textarea" id="ssEdCaption"' + (locked ? ' readonly' : '') + '>' + esc(p.caption || '') + '</textarea></label>' +
    '<label class="ss-field"><span>Hashtags</span><input class="ss-input" id="ssEdTags"' + (locked ? ' readonly' : '') + ' value="' + esc((p.hashtags || []).join(' ')) + '"></label>' +
    '<label class="ss-field"><span>When (Eastern)</span><input class="ss-input" type="datetime-local" id="ssEdWhen" value="' + esc(when) + '"' + (locked ? ' readonly' : '') + '></label>' +
    '<p class="ss-note" id="ssEdNote">Editing an approved post sends it back for approval.</p>' +
    '<div class="ss-card-actions">' + b.join('') + '</div>';
}
function openEditor(id) {
  const p = state.byId.get(id);
  if (!p) return;
  state.editingId = id;
  openSheet(platLabel(p.platform) + ' post', editorHtml(p));
}
function refreshEditorStatus() {
  const p = state.byId.get(state.editingId);
  const el = $('ssEdStatus');
  if (p && el) { el.textContent = S.STATUS_LABELS[p.status] || p.status; el.className = 'ss-badge st-' + p.status; }
}

function editorValues() {
  const caption = ($('ssEdCaption') && $('ssEdCaption').value) || '';
  const tags = (($('ssEdTags') && $('ssEdTags').value) || '').split(/[\s,]+/).filter(Boolean).map((t) => '#' + t.replace(/^#+/, ''));
  const whenMs = S.fromLocalInput($('ssEdWhen') && $('ssEdWhen').value);
  return { caption, tags, whenMs };
}

async function saveContent(p, caption, tags) {
  const same = caption === (p.caption || '') && tags.join(' ') === (p.hashtags || []).join(' ');
  if (same) return false;
  await updateDoc(postRef(p.id), { caption, hashtags: tags, status: 'draft', updatedAt: serverTimestamp() });
  return true;
}

// ── AI caption (proxy) with template fallback ────────────────────────────
function aiPrompt(p) {
  const facts = [
    'Platform: ' + platLabel(p.platform),
    'Post type: ' + (S.KIND_LABELS[p.kind] || p.kind),
    p.town ? 'Town: ' + p.town + (p.state ? ', ' + p.state : '') : '',
    p.packageLabel ? 'Package: ' + p.packageLabel : '',
    p.shingle ? 'Shingle: ' + p.shingle : '',
    (p.media || []).length ? 'Photos: ' + (p.format === 'before_after' ? 'a before and after pair' : (p.media.length + ' job photos')) : 'No photos',
    'Current draft: ' + (p.caption || ''),
  ].filter(Boolean).join('\n');
  return facts;
}
const AI_SYSTEM = 'You write short social media captions for Joe, who owns a small local roofing company and is on the roof for every job. ' +
  'Write in his plain, friendly, first-person voice: 2 or 3 short sentences, no hype, no emojis, no hashtags, no exclamation marks in a row. ' +
  'Never mention a customer\'s name, street, house number or exact location — the town is the most specific place you may name. ' +
  'Never mention insurance claims, adjusters, deductibles, or say Joe handles, files, negotiates or helps with a claim. ' +
  'End with a simple call to action like "Call or text me." Reply with the caption only.';

async function aiCaption(p) {
  if (typeof window.callClaude !== 'function') throw new Error('AI is not loaded');
  const run = window.callClaude({ model: AI_MODEL, max_tokens: 300, system: AI_SYSTEM, feature: 'social-studio', messages: [{ role: 'user', content: aiPrompt(p) }] });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('AI timed out')), 15000));
  const r = await Promise.race([run, timeout]);
  const text = r && r.content && r.content[0] && r.content[0].text ? String(r.content[0].text).trim() : '';
  if (!text) throw new Error('AI returned nothing');
  return text.replace(/^["']|["']$/g, '').replace(/#\w+/g, '').trim().slice(0, 1500);
}

/** After a job draft: one AI pass for the group, applied while still draft. */
async function aiPassForCreated(created) {
  const first = created.map((c) => state.byId.get(c.id)).find(Boolean);
  if (!first) return false;
  let text;
  try { text = await aiCaption(first); } catch (e) { console.warn('[social] AI caption unavailable, keeping template:', e && e.message); return false; }
  for (const c of created) {
    const p = state.byId.get(c.id);
    if (p && p.status === 'draft') {
      try { await updateDoc(postRef(c.id), { caption: text, status: 'draft', updatedAt: serverTimestamp() }); } catch (_) {}
    }
  }
  return true;
}

// ── Flows ────────────────────────────────────────────────────────────────
function platformChecks(defaults) {
  return '<div class="ss-checks">' + S.PLATFORM_ORDER.map((pl) =>
    '<label class="ss-check"><input type="checkbox" name="ssPlat" value="' + pl + '"' + (defaults.includes(pl) ? ' checked' : '') + '> ' + esc(platLabel(pl)) + '</label>').join('') + '</div>';
}
function chosenPlatforms() {
  return Array.from(document.querySelectorAll('input[name="ssPlat"]:checked')).map((el) => el.value);
}

async function openJobPicker() {
  openSheet('Draft from a job', '<div class="ss-empty">Finding finished jobs with photos…</div>');
  let jobs;
  try { jobs = (await call('socialEligibleJobs')).jobs || []; } catch (e) {
    $('ssSheetBody').innerHTML = '<div class="ss-err">' + esc(e.message) + '</div><div class="ss-card-actions"><button class="ss-btn" data-act="close">Close</button></div>';
    return;
  }
  state.jobs = jobs;
  if (!jobs.length) {
    $('ssSheetBody').innerHTML = '<div class="ss-empty">No finished jobs with photos yet. A job shows up here once it reaches Install Complete (or later) and has photos.</div><div class="ss-card-actions"><button class="ss-btn" data-act="close">Close</button></div>';
    return;
  }
  $('ssSheetBody').innerHTML =
    '<p class="ss-note">The post names the town only — never the customer, street or house number.</p>' +
    jobs.map((j, i) => '<button class="ss-job" data-act="pickjob" data-lead="' + esc(j.leadId) + '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '">' +
      '<strong>' + esc(j.label) + '</strong><small>' + esc([j.town && (j.town + (j.state ? ', ' + j.state : '')), j.packageLabel, j.photoCount + ' photos', j.format.replace('_', ' / '), j.alreadyPosted ? 'already posted' : ''].filter(Boolean).join(' · ')) + '</small></button>').join('') +
    '<div class="ss-field"><span>Platforms</span>' + platformChecks(['facebook', 'instagram']) + '</div>' +
    '<div class="ss-card-actions"><button class="ss-btn ss-btn-primary" id="ssGenerate" data-act="generate">Generate drafts</button><button class="ss-btn" data-act="close">Close</button></div>';
}

async function generateFromJob() {
  const picked = document.querySelector('.ss-job[aria-pressed="true"]');
  const platforms = chosenPlatforms();
  if (!picked) { toast('Pick a job.'); return; }
  if (!platforms.length) { toast('Pick at least one platform.'); return; }
  const btn = $('ssGenerate');
  if (btn) { btn.disabled = true; btn.textContent = 'Working… (photos are being cleaned)'; }
  try {
    const res = await call('socialDraftFromJob', { leadId: picked.dataset.lead, platforms });
    closeSheet();
    // wait (bounded) for the snapshot to carry the new docs, then one AI pass
    for (let i = 0; i < 20 && !res.created.every((c) => state.byId.has(c.id)); i++) await new Promise((r) => setTimeout(r, 150));
    const usedAi = await aiPassForCreated(res.created);
    switchTab('drafts');
    toast(res.created.length + ' draft' + (res.created.length === 1 ? '' : 's') + ' ready' + (usedAi ? ' (AI caption)' : ' (template caption)') + ' — review and approve.');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate drafts'; }
    toast(e.message || 'Could not draft that job.');
  }
}

function openPlanner() {
  openSheet('Plan weeks', '<p class="ss-note">Proposes a mix — job showcases, roof tips, storm-season PSAs, reviews and behind-the-scenes — as drafts. You approve each one.</p>' +
    '<label class="ss-field"><span>How many weeks</span><select class="ss-select" id="ssPlanWeeks">' +
    [1, 2, 3, 4, 6, 8].map((n) => '<option value="' + n + '"' + (n === 4 ? ' selected' : '') + '>' + n + ' week' + (n > 1 ? 's' : '') + '</option>').join('') + '</select></label>' +
    '<div class="ss-field"><span>Platforms</span>' + platformChecks(['facebook', 'instagram']) + '</div>' +
    '<div class="ss-card-actions"><button class="ss-btn ss-btn-primary" id="ssPlanGo" data-act="plan">Plan it</button><button class="ss-btn" data-act="close">Close</button></div>');
}
async function runPlan() {
  const platforms = chosenPlatforms();
  if (!platforms.length) { toast('Pick at least one platform.'); return; }
  const btn = $('ssPlanGo');
  if (btn) { btn.disabled = true; btn.textContent = 'Planning…'; }
  try {
    const res = await call('socialPlanWeeks', { weeks: Number($('ssPlanWeeks').value), platforms, startMs: Date.now() });
    closeSheet();
    switchTab('drafts');
    toast(res.created.length + ' drafts planned across ' + res.weeks + ' weeks — approve the ones you like.');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Plan it'; }
    toast(e.message || 'Could not plan.');
  }
}

async function approve(id) {
  const p = state.byId.get(id);
  if (!p) return;
  const v = editorValues();
  try {
    await saveContent(p, v.caption, v.tags);
    if (v.whenMs && v.whenMs < Date.now() - 60000) { toast('That time has already passed.'); return; }
    const res = await call('socialApprovePost', { postId: id, scheduledAtMs: v.whenMs || 0 });
    closeSheet();
    const note = res.dropped && res.dropped.length ? ' The rules removed ' + res.dropped.length + ' sentence' + (res.dropped.length === 1 ? '' : 's') + '.' : '';
    toast((res.status === 'scheduled' ? 'Approved and scheduled.' : 'Approved.') + note);
  } catch (e) { toast(e.message || 'Could not approve.'); }
}

async function applyReschedule(p, result) {
  if (!result.ok) { toast(result.error); return false; }
  const patch = { scheduledAt: Timestamp.fromMillis(result.patch.scheduledAtMs), updatedAt: serverTimestamp() };
  if (result.patch.status) patch.status = result.patch.status;
  try { await updateDoc(postRef(p.id), patch); toast('Moved to ' + fmtWhen(result.patch.scheduledAtMs) + '.'); return true; } catch (e) { toast(e.message); return false; }
}

async function moveTo(id) {
  const p = state.byId.get(id);
  if (!p) return;
  const v = editorValues();
  if (await saveContent(p, v.caption, v.tags)) { toast('Saved — the edit needs approval again.'); closeSheet(); return; }
  if (await applyReschedule(p, S.reschedule(p, v.whenMs, Date.now()))) closeSheet();
}

async function save(id) {
  const p = state.byId.get(id);
  if (!p) return;
  const v = editorValues();
  try {
    const changed = await saveContent(p, v.caption, v.tags);
    if (v.whenMs && v.whenMs !== S.ms(p.scheduledAt)) {
      const r = S.reschedule(p, v.whenMs, Date.now());
      if (r.ok) await updateDoc(postRef(id), { scheduledAt: Timestamp.fromMillis(r.patch.scheduledAtMs), updatedAt: serverTimestamp() });
    }
    toast(changed ? 'Saved as a draft.' : 'Saved.');
    closeSheet();
  } catch (e) { toast(e.message); }
}

async function writeWithAi(id) {
  const p = state.byId.get(id);
  if (!p) return;
  const note = $('ssEdNote');
  if (note) note.textContent = 'Asking the AI…';
  try {
    const text = await aiCaption(Object.assign({}, p, { caption: $('ssEdCaption').value }));
    $('ssEdCaption').value = text;
    if (note) note.textContent = 'AI draft — the privacy and Kentucky rules run again when you approve. Save or approve to keep it.';
  } catch (e) {
    if (note) note.textContent = 'AI is unavailable right now (' + (e.message || 'error') + '). The template caption is still here.';
  }
}

function openMarkPosted(id) {
  const p = state.byId.get(id);
  if (!p) return;
  state.editingId = id;
  openSheet('Mark posted', '<label class="ss-field"><span>Link to the live post</span><input class="ss-input" id="ssPostedUrl" type="url" inputmode="url" placeholder="https://"></label>' +
    '<div class="ss-card-actions"><button class="ss-btn ss-btn-primary" data-act="confirmposted" data-id="' + esc(id) + '">Save</button><button class="ss-btn" data-act="close">Close</button></div>');
}
async function confirmPosted(id) {
  const url = String($('ssPostedUrl').value || '').trim();
  if (!/^https:\/\/\S+$/.test(url)) { toast('Paste the https:// link to the post.'); return; }
  try {
    await updateDoc(postRef(id), { status: 'posted', postUrl: url, postedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    closeSheet();
    toast('Marked posted.');
  } catch (e) { toast(e.message); }
}

async function copyCaption(id) {
  const p = state.byId.get(id);
  if (!p) return;
  try { await navigator.clipboard.writeText(composeMessage(p)); toast('Caption copied.'); } catch (_) { toast('Copy failed — select the caption and copy it by hand.'); }
}

async function sharePhotos(id) {
  const p = state.byId.get(id);
  if (!p || !(p.media || []).length) return;
  try {
    const files = [];
    const media = isReel(p) ? [{ key: p.video.key, video: true }] : p.media;
    for (let i = 0; i < media.length; i++) {
      const r = await fetch(MEDIA_BASE + '?k=' + encodeURIComponent(media[i].key));
      if (!r.ok) throw new Error((media[i].video ? 'video' : 'photo ' + (i + 1)) + ' did not load');
      files.push(media[i].video ? new File([await r.blob()], 'nbd-reel.mp4', { type: 'video/mp4' }) : new File([await r.blob()], 'nbd-post-' + (i + 1) + '.jpg', { type: 'image/jpeg' }));
    }
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, text: composeMessage(p) });
      return;
    }
    files.forEach((f) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    });
    toast('Photos downloaded.');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('Could not share the photos: ' + (e.message || e));
  }
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function exportAll(kind) {
  const base = location.origin + MEDIA_BASE;
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'csv') download('social-posts-' + stamp + '.csv', S.toCSV(state.posts, base), 'text/csv');
  else download('social-posts-' + stamp + '.json', S.toJSON(state.posts, base, { companyId: state.companyId }), 'application/json');
}

async function saveSettings() {
  const platforms = {};
  document.querySelectorAll('input[data-platform]').forEach((el) => { platforms[el.dataset.platform] = el.checked; });
  try {
    await setDoc(doc(db, 'companies', state.companyId, 'social_settings', 'config'), { enabled: $('ssEnabled').checked, reels: !!($('ssReels') && $('ssReels').checked), platforms, updatedAt: serverTimestamp(), updatedBy: state.uid }, { merge: true });
    toast('Settings saved.');
  } catch (e) { toast(e.message); }
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.ss-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('[data-panel]').forEach((s) => { s.hidden = s.dataset.panel !== tab; });
}

const reels = initReels({
  db, storage, call, toast, esc, openSheet, closeSheet, switchTab, platformChecks, chosenPlatforms, $,
  get state() { return state; },
});

function shift(dir) {
  const d = new Date(state.anchorMs);
  if (state.view === 'month') { d.setUTCDate(15); d.setUTCMonth(d.getUTCMonth() + dir); state.anchorMs = d.getTime(); }
  else state.anchorMs += dir * 7 * 86400000;
  renderCalendar();
}

// ── Events (delegated; CSP: no inline handlers) ──────────────────────────
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act], .ss-tab, #ssNewFromJob, #ssPlan, #ssPrev, #ssNext, #ssViewWeek, #ssViewMonth, #ssExportJson, #ssExportCsv');
  if (!t) { if (ev.target === $('ssSheet')) closeSheet(); return; }
  if (t.classList.contains('ss-tab')) { switchTab(t.dataset.tab); return; }
  switch (t.id) {
    case 'ssNewFromJob': openJobPicker(); return;
    case 'ssPlan': openPlanner(); return;
    case 'ssPrev': shift(-1); return;
    case 'ssNext': shift(1); return;
    case 'ssViewWeek': state.view = 'week'; renderCalendar(); return;
    case 'ssViewMonth': state.view = 'month'; renderCalendar(); return;
    case 'ssExportJson': exportAll('json'); return;
    case 'ssExportCsv': exportAll('csv'); return;
    default: break;
  }
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case 'edit': openEditor(id); break;
    case 'close': closeSheet(); break;
    case 'lane': if (state.hiddenLanes.has(t.dataset.lane)) state.hiddenLanes.delete(t.dataset.lane); else state.hiddenLanes.add(t.dataset.lane); renderCalendar(); break;
    case 'pickjob': document.querySelectorAll('.ss-job').forEach((b) => b.setAttribute('aria-pressed', String(b === t))); break;
    case 'generate': generateFromJob(); break;
    case 'plan': runPlan(); break;
    case 'approve': approve(id); break;
    case 'move': moveTo(id); break;
    case 'save': save(id); break;
    case 'ai': writeWithAi(id); break;
    case 'cancel': updateDoc(postRef(id), { status: 'cancelled', updatedAt: serverTimestamp() }).then(() => { closeSheet(); toast('Cancelled.'); }, (e) => toast(e.message)); break;
    case 'delete': deleteDoc(postRef(id)).then(() => { closeSheet(); toast('Deleted.'); }, (e) => toast(e.message)); break;
    case 'markposted': openMarkPosted(id); break;
    case 'confirmposted': confirmPosted(id); break;
    case 'copy': copyCaption(id); break;
    case 'share': sharePhotos(id); break;
    default: break;
  }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'ssEnabled' || ev.target.id === 'ssReels' || (ev.target.dataset && ev.target.dataset.platform)) saveSettings();
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('ssSheet').hidden) closeSheet(); });

// Desktop drag to reschedule (phones use tap → date picker in the editor).
document.addEventListener('dragstart', (ev) => {
  const chip = ev.target.closest && ev.target.closest('.ss-chip[draggable="true"]');
  if (!chip) return;
  state.dragId = chip.dataset.id;
  try { ev.dataTransfer.setData('text/plain', chip.dataset.id); ev.dataTransfer.effectAllowed = 'move'; } catch (_) {}
});
document.addEventListener('dragover', (ev) => {
  const day = ev.target.closest && ev.target.closest('[data-day]');
  if (!day || !state.dragId) return;
  ev.preventDefault();
  document.querySelectorAll('.drop').forEach((d) => d !== day && d.classList.remove('drop'));
  day.classList.add('drop');
});
document.addEventListener('drop', (ev) => {
  const day = ev.target.closest && ev.target.closest('[data-day]');
  document.querySelectorAll('.drop').forEach((d) => d.classList.remove('drop'));
  if (!day || !state.dragId) return;
  ev.preventDefault();
  const p = state.byId.get(state.dragId);
  state.dragId = null;
  if (p) applyReschedule(p, S.dropOnDay(p, day.dataset.day, Date.now()));
});
document.addEventListener('dragend', () => { state.dragId = null; document.querySelectorAll('.drop').forEach((d) => d.classList.remove('drop')); });

renderCalendar();
