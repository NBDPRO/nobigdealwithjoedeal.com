/**
 * docs/pro/js/reel-studio-logic.js — pure helpers for Social Studio's Reels
 * tab (Reel Studio, 2026-10-04). No DOM, no Firebase: loaded by
 * /pro/social.html as a classic script (window.NBDReelLogic) and by Node
 * tests via module.exports.
 *
 * The server (functions/reel-logic.js) is the authority on every rule; this
 * file only decides what the page SHOWS (labels, which buttons) so a rule
 * the server enforces is never offered as a button that will just fail.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NBDReelLogic = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var TEMPLATES = {
    slideshow: { label: 'Photo slideshow', hint: 'Job photos with slow Ken Burns pans.', sources: ['photo'], min: 1, max: 20, job: true },
    before_after: { label: 'Before / after reveal', hint: 'A before and an after, with a wipe reveal.', sources: ['photo', 'video'], min: 2, max: 2, job: true },
    job_of_week: { label: 'Job of the week', hint: 'Town, package and shingle on the photos. No prices.', sources: ['photo'], min: 1, max: 6, job: true },
    drone_cut: { label: 'Drone cut', hint: 'Best stretch of one drone clip, optional speed ramp.', sources: ['video'], min: 1, max: 1, job: false },
    talking_head: { label: 'Talking to camera', hint: 'Trim plus burned-in captions.', sources: ['video'], min: 1, max: 1, job: false },
  };
  var TEMPLATE_ORDER = ['slideshow', 'before_after', 'job_of_week', 'drone_cut', 'talking_head'];
  var FLAG_LABELS = { house_number: 'Readable house number', license_plate: 'License plate', street_sign: 'Street sign', face: "A person's face" };
  var STATUS_LABELS = { queued: 'Waiting to render', rendering: 'Rendering…', rendered: 'Rendered', failed: 'Render failed' };
  var MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
  var VIDEO_RE = /^video\/(mp4|quicktime|x-m4v|webm|3gpp)$/;
  var IMAGE_RE = /^image\/(jpeg|png|webp|heic|heif)$/;
  var AI_IMAGE_KINDS = ['tip', 'storm_psa'];

  function fmtSec(s) {
    var n = Math.max(0, Math.round(Number(s) || 0));
    return Math.floor(n / 60) + ':' + (n % 60 < 10 ? '0' : '') + (n % 60);
  }

  /** Why a picked file cannot be uploaded ('' = fine). */
  function uploadProblem(file, purpose) {
    if (!file) return 'No file.';
    var t = String(file.type || '').toLowerCase();
    // iPhone sometimes reports '' for .mov / .heic — fall back on the name.
    if (!t) {
      var n = String(file.name || '').toLowerCase();
      if (/\.(mov|qt)$/.test(n)) t = 'video/quicktime';
      else if (/\.mp4$/.test(n)) t = 'video/mp4';
      else if (/\.(heic|heif)$/.test(n)) t = 'image/heic';
    }
    if (purpose === 'ai_image' && !IMAGE_RE.test(t)) return 'An AI graphic must be an image (JPEG, PNG, WebP or HEIC).';
    if (!VIDEO_RE.test(t) && !IMAGE_RE.test(t)) return 'Videos (MP4 / MOV) or photos only.';
    if (!(file.size > 0)) return 'That file is empty.';
    if (file.size > MAX_UPLOAD_BYTES) return 'Files up to 500 MB.';
    return '';
  }
  function contentTypeOf(file) {
    var t = String((file && file.type) || '').toLowerCase();
    if (t) return t;
    var n = String((file && file.name) || '').toLowerCase();
    if (/\.(mov|qt)$/.test(n)) return 'video/quicktime';
    if (/\.mp4$/.test(n)) return 'video/mp4';
    if (/\.(heic|heif)$/.test(n)) return 'image/heic';
    if (/\.png$/.test(n)) return 'image/png';
    return 'image/jpeg';
  }

  /**
   * Default picks for a template from a job's photos [{ id, phase }]:
   * before/after → first before + last after; job of the week → afters
   * (else everything) up to 4; slideshow → everything up to 12.
   */
  function defaultPicks(template, photos) {
    var ps = photos || [];
    var before = ps.filter(function (p) { return p.phase === 'before'; });
    var after = ps.filter(function (p) { return p.phase === 'after'; });
    if (template === 'before_after') {
      if (before.length && after.length) return [before[0].id, after[after.length - 1].id];
      return ps.slice(0, 2).map(function (p) { return p.id; });
    }
    if (template === 'job_of_week') return (after.length ? after : ps).slice(0, 4).map(function (p) { return p.id; });
    if (template === 'slideshow') return ps.slice(0, 12).map(function (p) { return p.id; });
    return [];
  }

  /** Is the selection the right shape for the template? → '' or a message. */
  function selectionProblem(template, picks) {
    var t = TEMPLATES[template];
    if (!t) return 'Pick a template.';
    var list = picks || [];
    var bad = list.filter(function (p) { return t.sources.indexOf(p.type) === -1; });
    if (bad.length) return t.label + ' takes ' + t.sources.join(' or ') + 's only.';
    if (list.length < t.min) return t.label + ' needs ' + t.min + (t.min === 1 ? ' item.' : ' items.');
    if (list.length > t.max) return t.label + ' takes at most ' + t.max + '.';
    return '';
  }

  /**
   * What the reel card shows. Mirrors the server gate (reel-logic
   * canApproveReel / blurAvailable): approval only when the render is done
   * and privacy is clear, confirmed or blurred.
   */
  function privacyView(reel) {
    var r = reel || {};
    var pv = r.privacy || {};
    var flags = pv.flags || [];
    var speech = pv.speechDropped || [];
    var text = pv.textDropped || [];
    var rendered = r.status === 'rendered' && r.output && r.output.key;
    var blurOk = pv.status === 'flagged' && !speech.length && !text.length && flags.length > 0 &&
      flags.every(function (f) { return Array.isArray(f.box) && f.box.length === 4; });
    var v = { status: pv.status || 'pending', tone: 'muted', label: 'Privacy check pending', canConfirm: false, canBlur: false, approvable: false, lines: [] };
    if (!rendered) return v;
    if (pv.status === 'clear') { v.tone = 'ok'; v.label = 'Privacy check: nothing found'; v.approvable = true; }
    else if (pv.status === 'confirmed') { v.tone = 'ok'; v.label = 'Privacy: you confirmed it'; v.approvable = true; }
    else if (pv.status === 'blurred') { v.tone = 'ok'; v.label = 'Privacy: flagged areas blurred'; v.approvable = true; }
    else if (pv.status === 'flagged') {
      v.tone = 'warn'; v.label = 'Privacy check flagged ' + (flags.length + speech.length + text.length) + ' thing' + ((flags.length + speech.length + text.length) === 1 ? '' : 's');
      v.canConfirm = true; v.canBlur = blurOk;
    } else if (pv.status === 'unchecked') {
      v.tone = 'warn'; v.label = 'Privacy check could not run (' + (pv.reason || 'unavailable') + ') — watch it and confirm';
      v.canConfirm = true;
    }
    flags.forEach(function (f) { v.lines.push((FLAG_LABELS[f.type] || f.type) + ' at ' + fmtSec(f.t) + (f.box ? '' : ' (no box — blur unavailable)')); });
    speech.forEach(function (s) { v.lines.push('Speech removed from captions (' + s.rule + '): the audio still says it'); });
    text.forEach(function (s) { v.lines.push('On-screen ' + s.text + ' removed (' + s.rule + ')'); });
    return v;
  }

  function reelStatusLabel(reel) {
    var r = reel || {};
    if (r.status === 'queued' && r.op === 'blur') return 'Waiting to blur';
    if (r.status === 'rendering' && r.op === 'blur') return 'Blurring…';
    return STATUS_LABELS[r.status] || r.status || '';
  }

  /** Stuck render (the worker died) → offer Retry. */
  function canRetry(reel, nowMs) {
    var r = reel || {};
    if (r.status === 'failed') return true;
    var st = Number((r.render || {}).startedAtMs) || 0;
    return r.status === 'rendering' && st > 0 && (nowMs || Date.now()) - st > 12 * 60 * 1000;
  }

  function aiImageKindOk(kind) { return AI_IMAGE_KINDS.indexOf(kind) !== -1; }

  return {
    TEMPLATES: TEMPLATES, TEMPLATE_ORDER: TEMPLATE_ORDER, FLAG_LABELS: FLAG_LABELS, AI_IMAGE_KINDS: AI_IMAGE_KINDS, MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    fmtSec: fmtSec, uploadProblem: uploadProblem, contentTypeOf: contentTypeOf, defaultPicks: defaultPicks, selectionProblem: selectionProblem,
    privacyView: privacyView, reelStatusLabel: reelStatusLabel, canRetry: canRetry, aiImageKindOk: aiImageKindOk,
  };
});
