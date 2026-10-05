/**
 * pages/social-reels.js — the Reels tab of Social Studio (Reel Studio,
 * 2026-10-04). Imported by pages/social-studio.js, which owns Firebase init,
 * the bottom sheet, toasts and tabs; this module owns reels + uploads.
 *
 *   - Upload clips / photos from the phone: reelStartUpload mints a slot,
 *     then a RESUMABLE Storage upload to reel-uploads/{company}/{uid}/{id};
 *     the server transcodes it (metadata + GPS stripped) and deletes the raw.
 *   - New reel: template (data-driven), 9:16 or 1:1, a finished job's photos
 *     and/or uploaded clips → reelCreate (the server renders it).
 *   - Each reel: preview, privacy check result, Confirm / Blur flagged areas
 *     / Retry, and "Send to Social Studio" (drafts on the calendar; approval
 *     stays locked until privacy is clear, confirmed or blurred).
 *   - AI graphic: upload one Jo made in SuperGrok / Gemini → a tip or
 *     storm-season draft tagged aiGenerated. Never a job showcase.
 *
 * Reads companies/{c}/reels + reel_media (firestore.rules: owner +
 * company_admin read, server-only write). CSP: delegated listeners only.
 */
import { collection, onSnapshot, query, limit } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref as sref, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const R = window.NBDReelLogic;
const MEDIA_BASE = '/api/social-media';

export function initReels(ctx) {
  const { db, storage, call, toast, esc, openSheet, closeSheet, switchTab, platformChecks, chosenPlatforms, $ } = ctx;
  const st = { reels: [], media: [], progress: new Map(), draft: null, aiKind: 'tip', uploadPurpose: 'clip' };

  function companyId() { return ctx.state.companyId; }

  function subscribe() {
    onSnapshot(query(collection(db, 'companies', companyId(), 'reels'), limit(200)), (snap) => {
      const list = [];
      snap.forEach((d) => list.push(Object.assign({ id: d.id }, d.data())));
      list.sort((a, b) => (Number((b.render || {}).requestedAtMs) || 0) - (Number((a.render || {}).requestedAtMs) || 0));
      st.reels = list;
      render();
    }, (err) => { $('srList').innerHTML = '<div class="ss-err">Could not load reels: ' + esc(err.message) + '</div>'; });
    onSnapshot(query(collection(db, 'companies', companyId(), 'reel_media'), limit(300)), (snap) => {
      const list = [];
      snap.forEach((d) => list.push(Object.assign({ id: d.id }, d.data())));
      list.sort((a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0));
      st.media = list;
      renderMedia();
      if (st.draft && !$('ssSheet').hidden && $('srDraft')) renderDraft();
    }, () => {});
  }

  // ── Lists ───────────────────────────────────────────────────────────────
  function render() {
    const c = $('ssCountReels');
    if (c) c.textContent = String(st.reels.filter((r) => r.status !== 'rendered' || R.privacyView(r).canConfirm).length);
    $('srList').innerHTML = st.reels.length ? st.reels.map(reelCard).join('') : '<div class="ss-empty">No reels yet. Tap “+ New reel” to make one from a finished job’s photos or your clips.</div>';
  }

  function reelCard(r) {
    const pv = R.privacyView(r);
    const tpl = (R.TEMPLATES[r.template] || {}).label || r.template;
    const out = r.output || {};
    const video = r.status === 'rendered' && out.key
      ? '<video class="sr-video ' + (r.aspect === '1:1' ? 'sr-a11' : 'sr-a916') + '" controls playsinline preload="metadata" src="' + esc(MEDIA_BASE + '?k=' + out.key) + '"' + (out.thumbKey ? ' poster="' + esc(MEDIA_BASE + '?k=' + out.thumbKey) + '"' : '') + '></video>'
      : '';
    const acts = [];
    if (pv.canConfirm) acts.push('<button class="ss-btn ss-btn-small" data-act="rconfirm" data-id="' + esc(r.id) + '">Looks fine — confirm</button>');
    if (pv.canBlur) acts.push('<button class="ss-btn ss-btn-small" data-act="rblur" data-id="' + esc(r.id) + '">Blur flagged areas</button>');
    if (R.canRetry(r, Date.now())) acts.push('<button class="ss-btn ss-btn-small" data-act="rretry" data-id="' + esc(r.id) + '">Retry</button>');
    if (r.status === 'rendered') {
      acts.push('<button class="ss-btn ss-btn-small ss-btn-primary" data-act="rsend" data-id="' + esc(r.id) + '">Send to Social Studio</button>');
      acts.push('<a class="ss-btn ss-btn-small sr-link" download="nbd-reel.mp4" href="' + esc(MEDIA_BASE + '?k=' + out.key) + '">Download MP4</a>');
    }
    const err = r.status === 'failed' && r.render && r.render.error ? '<div class="ss-err">' + esc(r.render.error) + '</div>' : '';
    const posts = (r.postIds || []).length ? '<div class="ss-note">' + r.postIds.length + ' post' + (r.postIds.length === 1 ? '' : 's') + ' in Social Studio' + (pv.approvable ? '' : ' — approval unlocks once privacy is cleared') + '.</div>' : '';
    const caps = r.captions && r.captions.status === 'unavailable' ? '<div class="ss-warn">Captions unavailable (' + esc(r.captions.reason || '') + ').</div>' : '';
    return '<article class="ss-card sr-card" data-reel="' + esc(r.id) + '">' +
      '<div class="ss-card-h"><span class="ss-badge">' + esc(tpl) + '</span><span class="ss-badge">' + esc(r.aspect || '9:16') + '</span>' +
      '<span class="ss-badge sr-st-' + esc(r.status) + '">' + esc(R.reelStatusLabel(r)) + '</span>' +
      (out.durationSec ? '<span class="ss-card-when">' + esc(R.fmtSec(out.durationSec)) + '</span>' : '') + '</div>' +
      video + err + caps +
      (r.status === 'rendered' ? '<div class="sr-privacy sr-' + esc(pv.tone) + '" data-privacy="' + esc(pv.status) + '"><strong>' + esc(pv.label) + '</strong>' +
        (pv.lines.length ? '<ul>' + pv.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' : '') + '</div>' : '') +
      posts + '<div class="ss-card-actions">' + acts.join('') + '</div></article>';
  }

  function renderMedia() {
    const el = $('srMedia');
    if (!el) return;
    const rows = st.media.filter((m) => m.status !== 'expired').slice(0, 30).map((m) => {
      const pct = st.progress.get(m.id);
      const state = m.status === 'awaiting_upload' ? (pct != null ? 'Uploading ' + pct + '%' : 'Waiting for upload')
        : m.status === 'processing' ? 'Cleaning + converting…' : m.status === 'ready' ? 'Ready' : m.status === 'failed' ? 'Failed: ' + (m.error || '') : m.status;
      const ai = m.aiGenerated ? '<span class="ss-badge sr-ai">AI graphic</span>' : '';
      const act = m.aiGenerated && m.status === 'ready' ? '<button class="ss-btn ss-btn-small" data-act="raipost" data-id="' + esc(m.id) + '">Make a ' + esc(m.postKind === 'storm_psa' ? 'storm PSA' : 'tip') + ' post</button>' : '';
      return '<div class="sr-media-row"><span class="ss-badge">' + esc(m.kind === 'video' ? 'Clip' : 'Photo') + '</span>' + ai +
        '<span class="sr-media-name">' + esc(m.name || m.id) + (m.durationSec ? ' · ' + esc(R.fmtSec(m.durationSec)) : '') + '</span>' +
        '<span class="sr-media-state">' + esc(state) + '</span>' + act + '</div>';
    });
    el.innerHTML = rows.length ? rows.join('') : '<div class="ss-note">No uploads yet.</div>';
  }

  // ── Uploads ─────────────────────────────────────────────────────────────
  async function uploadFiles(files, purpose, extra) {
    for (const f of files) {
      const problem = R.uploadProblem(f, purpose);
      if (problem) { toast((f.name || 'File') + ': ' + problem); continue; }
      let slot;
      try {
        slot = await call('reelStartUpload', Object.assign({ contentType: R.contentTypeOf(f), bytes: f.size, name: f.name, purpose }, extra || {}));
      } catch (e) { toast(e.message || 'Could not start the upload.'); continue; }
      st.progress.set(slot.mediaId, 0);
      renderMedia();
      await new Promise((resolve) => {
        const task = uploadBytesResumable(sref(storage, slot.path), f, { contentType: R.contentTypeOf(f) });
        task.on('state_changed', (s) => {
          st.progress.set(slot.mediaId, Math.round((s.bytesTransferred / Math.max(1, s.totalBytes)) * 100));
          renderMedia();
        }, (err) => { toast('Upload failed: ' + (err && err.message)); st.progress.delete(slot.mediaId); renderMedia(); resolve(); },
        () => { st.progress.delete(slot.mediaId); renderMedia(); resolve(); });
      });
    }
    toast('Uploaded — the server is cleaning the files (GPS and metadata removed).');
  }

  // ── New reel sheet ──────────────────────────────────────────────────────
  function openNew() {
    st.draft = { template: 'slideshow', aspect: '9:16', leadId: null, jobLabel: '', jobs: null, photos: [], clips: [], picks: new Set(), params: { title: '', seconds: 15, speedRamp: false, trimStart: 0, trimEnd: 0, captions: true }, kind: 'tip', busy: false };
    openSheet('New reel', '<div id="srDraft"></div>');
    renderDraft();
  }

  function pickedItems() {
    const d = st.draft;
    const out = [];
    d.photos.forEach((p) => { if (d.picks.has('p:' + p.id)) out.push({ source: 'job_photo', photoId: p.id, type: 'photo' }); });
    loose().concat(d.clips.map((c) => ({ id: c.mediaId, kind: c.kind, durationSec: c.durationSec, name: c.name }))).forEach((m) => {
      if (d.picks.has('m:' + m.id) && !out.some((x) => x.mediaId === m.id)) out.push({ source: 'upload', mediaId: m.id, type: m.kind });
    });
    return out;
  }
  // Uploads not tied to any job (talking-to-camera tips, drone b-roll).
  function loose() { return st.media.filter((m) => m.status === 'ready' && !m.aiGenerated && !m.leadId).map((m) => ({ id: m.id, kind: m.kind, durationSec: m.durationSec, name: m.name })); }

  function renderDraft() {
    const d = st.draft;
    const host = $('srDraft');
    if (!d || !host) return;
    const tpl = R.TEMPLATES[d.template];
    let h = '<div class="ss-field"><span>Template</span><div class="sr-tpls">' + R.TEMPLATE_ORDER.map((k) =>
      '<button class="ss-job" data-act="rtpl" data-tpl="' + k + '" aria-pressed="' + String(k === d.template) + '"><strong>' + esc(R.TEMPLATES[k].label) + '</strong><small>' + esc(R.TEMPLATES[k].hint) + '</small></button>').join('') + '</div></div>';
    h += '<div class="ss-field"><span>Shape</span><div class="ss-seg" role="group" aria-label="Reel shape">' +
      ['9:16', '1:1'].map((a) => '<button data-act="raspect" data-aspect="' + a + '" aria-pressed="' + String(a === d.aspect) + '">' + (a === '9:16' ? '9:16 Reel' : '1:1 Square') + '</button>').join('') + '</div></div>';
    h += '<div class="ss-field"><span>Job</span>' + (d.leadId
      ? '<div class="sr-picked-job"><strong>' + esc(d.jobLabel) + '</strong> <button class="ss-btn ss-btn-small" data-act="rjobs">Change</button></div>'
      : '<button class="ss-btn" data-act="rjobs" id="srPickJob">' + (tpl.job ? 'Pick a finished job' : 'Pick a job (optional)') + '</button>') + '</div>';
    if (d.jobs && !d.leadId) {
      h += d.jobs.length ? d.jobs.map((j) => '<button class="ss-job" data-act="rjob" data-lead="' + esc(j.leadId) + '"><strong>' + esc(j.label) + '</strong><small>' +
        esc([j.town && (j.town + (j.state ? ', ' + j.state : '')), j.packageLabel, j.photoCount + ' photos'].filter(Boolean).join(' · ')) + '</small></button>').join('')
        : '<div class="ss-note">No finished jobs with photos yet.</div>';
    }
    const items = [];
    if (tpl.sources.indexOf('photo') !== -1) d.photos.forEach((p) => items.push({ key: 'p:' + p.id, label: (p.phase ? p.phase[0].toUpperCase() + p.phase.slice(1) : 'Photo') + (p.createdAtMs ? ' · ' + new Date(p.createdAtMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''), type: 'photo' }));
    const clipList = d.clips.map((c) => ({ id: c.mediaId, kind: c.kind, durationSec: c.durationSec, name: c.name })).concat(loose());
    const seen = new Set();
    clipList.forEach((m) => {
      if (seen.has(m.id) || tpl.sources.indexOf(m.kind) === -1) return;
      seen.add(m.id);
      items.push({ key: 'm:' + m.id, label: (m.kind === 'video' ? 'Clip ' : 'Photo ') + (m.name || '') + (m.durationSec ? ' · ' + R.fmtSec(m.durationSec) : ''), type: m.kind });
    });
    h += '<div class="ss-field"><span>Photos and clips (' + tpl.min + (tpl.max > tpl.min ? '–' + tpl.max : '') + ')</span>' +
      (items.length ? '<div class="sr-picks">' + items.map((it) => '<label class="ss-check sr-pick"><input type="checkbox" data-act="rpick" data-key="' + esc(it.key) + '"' + (d.picks.has(it.key) ? ' checked' : '') + '> ' + esc(it.label) + '</label>').join('') + '</div>'
        : '<div class="ss-note">' + (tpl.sources.indexOf('video') !== -1 ? 'Upload a clip first (Reels → Upload clips).' : 'Pick a job with photos.') + '</div>') + '</div>';
    h += '<label class="ss-field"><span>Title on the intro card (optional)</span><input class="ss-input" id="srTitle" maxlength="60" value="' + esc(d.params.title) + '" placeholder="New roof · your town"></label>';
    if (d.template === 'drone_cut') {
      h += '<label class="ss-field"><span>Seconds of drone footage</span><input class="ss-input" id="srSeconds" type="number" min="5" max="60" value="' + esc(d.params.seconds) + '"></label>' +
        '<label class="ss-check"><input type="checkbox" id="srRamp"' + (d.params.speedRamp ? ' checked' : '') + '> Speed ramp (fast middle)</label>';
    }
    if (d.template === 'talking_head') {
      h += '<div class="sr-row"><label class="ss-field"><span>Start at (s)</span><input class="ss-input" id="srTrimStart" type="number" min="0" step="0.5" value="' + esc(d.params.trimStart) + '"></label>' +
        '<label class="ss-field"><span>End at (s, 0 = end)</span><input class="ss-input" id="srTrimEnd" type="number" min="0" step="0.5" value="' + esc(d.params.trimEnd) + '"></label></div>' +
        '<label class="ss-check"><input type="checkbox" id="srCaptions"' + (d.params.captions ? ' checked' : '') + '> Burn in captions</label>' +
        '<label class="ss-field"><span>Post type</span><select class="ss-select" id="srKind">' + [['tip', 'Roof tip'], ['storm_psa', 'Storm-season PSA'], ['behind_scenes', 'Behind the scenes']].map((o) => '<option value="' + o[0] + '"' + (o[0] === d.kind ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>';
    }
    const problem = R.selectionProblem(d.template, pickedItems());
    h += '<p class="ss-note">Every reel gets the brand intro and outro. Names, streets and house numbers never go on screen; a privacy check looks at the frames before you can approve it.</p>';
    h += '<div class="ss-card-actions"><button class="ss-btn ss-btn-primary" id="srRender" data-act="rrender"' + (problem || d.busy ? ' disabled' : '') + '>' + (d.busy ? 'Starting…' : 'Render') + '</button><button class="ss-btn" data-act="close">Close</button></div>' +
      (problem ? '<div class="ss-note" id="srProblem">' + esc(problem) + '</div>' : '');
    host.innerHTML = h;
  }

  function readParams() {
    const d = st.draft;
    const v = (id) => ($(id) ? $(id).value : '');
    d.params.title = v('srTitle');
    if ($('srSeconds')) d.params.seconds = Number(v('srSeconds')) || 15;
    if ($('srRamp')) d.params.speedRamp = $('srRamp').checked;
    if ($('srTrimStart')) d.params.trimStart = Number(v('srTrimStart')) || 0;
    if ($('srTrimEnd')) d.params.trimEnd = Number(v('srTrimEnd')) || 0;
    if ($('srCaptions')) d.params.captions = $('srCaptions').checked;
    if ($('srKind')) d.kind = v('srKind');
  }

  async function loadJobs() {
    const d = st.draft;
    readParams();
    d.leadId = null; d.photos = []; d.clips = []; d.picks = new Set();
    d.jobs = [];
    renderDraft();
    try { d.jobs = (await call('socialEligibleJobs')).jobs || []; } catch (e) { toast(e.message); }
    renderDraft();
  }

  async function pickJob(leadId) {
    const d = st.draft;
    const j = (d.jobs || []).find((x) => x.leadId === leadId);
    d.leadId = leadId; d.jobLabel = j ? j.label : 'Job'; d.jobs = null;
    renderDraft();
    try {
      const res = await call('reelJobMedia', { leadId });
      d.photos = res.photos || [];
      d.clips = res.clips || [];
      d.picks = new Set(R.defaultPicks(d.template, d.photos).map((id) => 'p:' + id));
    } catch (e) { toast(e.message); }
    renderDraft();
  }

  async function startRender() {
    const d = st.draft;
    readParams();
    const items = pickedItems();
    const problem = R.selectionProblem(d.template, items);
    if (problem) { toast(problem); return; }
    d.busy = true; renderDraft();
    try {
      await call('reelCreate', {
        template: d.template, aspect: d.aspect, leadId: d.leadId, kind: d.kind, params: d.params,
        clips: items.map((x) => (x.source === 'job_photo' ? { source: 'job_photo', photoId: x.photoId } : { source: 'upload', mediaId: x.mediaId })),
      });
      closeSheet();
      switchTab('reels');
      toast('Rendering — usually a minute or two. The privacy check runs right after.');
    } catch (e) {
      d.busy = false; renderDraft();
      toast(e.message || 'Could not start the render.');
    }
  }

  function openSend(id) {
    const r = st.reels.find((x) => x.id === id);
    if (!r) return;
    const pv = R.privacyView(r);
    openSheet('Send to Social Studio',
      '<p class="ss-note">Makes a draft per platform with a proposed time (tomorrow 10:00 AM). Facebook and Instagram post the video by themselves once approved; the others land in Ready to post with a Download MP4 button.</p>' +
      (pv.approvable ? '' : '<p class="ss-warn">Approval stays locked until the privacy check is cleared (confirm or blur).</p>') +
      '<div class="ss-field"><span>Platforms</span>' + platformChecks(['facebook', 'instagram']) + '</div>' +
      '<div class="ss-card-actions"><button class="ss-btn ss-btn-primary" id="srSendGo" data-act="rsendgo" data-id="' + esc(id) + '">Make drafts</button><button class="ss-btn" data-act="close">Close</button></div>');
  }

  async function send(id) {
    const platforms = chosenPlatforms();
    if (!platforms.length) { toast('Pick at least one platform.'); return; }
    const btn = $('srSendGo');
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    try {
      const res = await call('reelToPosts', { reelId: id, platforms });
      closeSheet();
      switchTab('calendar');
      toast(res.created.length + ' reel draft' + (res.created.length === 1 ? '' : 's') + ' on the calendar — approve when ready.');
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Make drafts'; }
      toast(e.message || 'Could not make the drafts.');
    }
  }

  function openAi() {
    openSheet('AI graphic → tip or storm post',
      '<p class="ss-note">For a graphic you made in SuperGrok or Gemini. AI images are only for tip and storm-season posts — never a job showcase, never shown as real work. The caption says it was made with AI.</p>' +
      '<label class="ss-field"><span>Post type</span><select class="ss-select" id="srAiKind"><option value="tip">Roof tip</option><option value="storm_psa">Storm-season PSA</option></select></label>' +
      '<div class="ss-card-actions"><button class="ss-btn ss-btn-primary" data-act="raipick">Choose the image</button><button class="ss-btn" data-act="close">Close</button></div>');
  }

  async function act(t) {
    const id = t.dataset.id;
    switch (t.dataset.act) {
      case 'rnew': openNew(); break;
      case 'rupload': st.uploadPurpose = 'clip'; $('srFile').value = ''; $('srFile').click(); break;
      case 'rai': openAi(); break;
      case 'raipick': {
        const k = $('srAiKind') ? $('srAiKind').value : 'tip';
        if (!R.aiImageKindOk(k)) { toast('AI images are for tip and storm-season posts only.'); return; }
        st.aiKind = k; st.uploadPurpose = 'ai_image'; closeSheet(); $('srAiFile').value = ''; $('srAiFile').click(); break;
      }
      case 'raipost':
        try { const r = await call('reelAiImagePost', { mediaId: id, platforms: ['facebook', 'instagram'] }); switchTab('drafts'); toast(r.created.length + ' AI-graphic draft' + (r.created.length === 1 ? '' : 's') + ' made (tagged AI).'); } catch (e) { toast(e.message); }
        break;
      case 'rtpl': readParams(); st.draft.template = t.dataset.tpl; st.draft.picks = new Set(R.defaultPicks(st.draft.template, st.draft.photos).map((x) => 'p:' + x)); renderDraft(); break;
      case 'raspect': readParams(); st.draft.aspect = t.dataset.aspect; renderDraft(); break;
      case 'rjobs': loadJobs(); break;
      case 'rjob': pickJob(t.dataset.lead); break;
      case 'rpick': readParams(); if (t.checked) st.draft.picks.add(t.dataset.key); else st.draft.picks.delete(t.dataset.key); renderDraft(); break;
      case 'rrender': startRender(); break;
      case 'rconfirm':
        try { await call('reelConfirmPrivacy', { reelId: id }); toast('Confirmed — this reel can be approved now.'); } catch (e) { toast(e.message); }
        break;
      case 'rblur':
        try { await call('reelApplyBlur', { reelId: id }); toast('Blurring the flagged areas…'); } catch (e) { toast(e.message); }
        break;
      case 'rretry':
        try { await call('reelRetry', { reelId: id }); toast('Queued again.'); } catch (e) { toast(e.message); }
        break;
      case 'rsend': openSend(id); break;
      case 'rsendgo': send(id); break;
      default: break;
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-act^="r"]');
    if (!t || t.dataset.act === 'rpick') return;
    act(t);
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t && t.dataset && t.dataset.act === 'rpick') { act(t); return; }
    if (t && t.id === 'srFile' && t.files && t.files.length) uploadFiles(Array.from(t.files), 'clip', {});
    if (t && t.id === 'srAiFile' && t.files && t.files.length) uploadFiles(Array.from(t.files).slice(0, 1), 'ai_image', { postKind: st.aiKind });
  });

  return { start: subscribe };
}
