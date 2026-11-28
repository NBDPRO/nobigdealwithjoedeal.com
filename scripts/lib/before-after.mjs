/**
 * before-after.mjs — validation and markup for the before/after comparison
 * and the short job clips (2026-11-27). Used by scripts/build-projects.mjs;
 * unit-tested by tests/before-after-component.test.js.
 *
 * DATA (docs/assets/data/projects.json, both optional per project):
 *
 *   "beforeAfter": [{
 *     "before": "/assets/images/projects/<x>.jpg",   // must be one of the job's photos[]
 *     "after":  "/assets/images/projects/<y>.jpg",   // must be one of the job's photos[]
 *     "service": "roof-replacement",                 // what the PAIR shows (one of the job's services[])
 *     "caption": "Rear of the house, same drone angle",  // optional
 *     "beforeLabel": "Bare deck", "afterLabel": "Finished"  // optional, default Before / After
 *   }]
 *
 *   "clips": [{
 *     "src": "/assets/video/projects/<slug>-1.mp4",  // H.264 MP4, metadata stripped
 *     "webm": "/assets/video/projects/<slug>-1.webm",// optional smaller alternate
 *     "poster": "/assets/images/projects/<slug>-clip-1.jpg",
 *     "captions": "/assets/video/projects/<slug>-1.en.vtt",
 *     "title": "Tear-off on the back slope",
 *     "width": 720, "height": 1280                   // the file's pixel size (vertical phone video is fine)
 *   }]
 *
 * A pair is only honest when both photos are the SAME spot, before and after,
 * so the pair points at photos the job already publishes (they were already
 * EXIF-stripped and consent-checked on the way in) and names the service the
 * photos actually show. A clip is never autoplayed, starts muted, loads
 * nothing until it is played (preload="none"), and must ship a captions track.
 * Phone video carries GPS in its metadata like photos do, so a clip file that
 * still holds a QuickTime location atom is refused.
 */
import { readFileSync } from 'node:fs';

export const BA_CSS = '<link rel="stylesheet" href="/assets/css/before-after.css?v=1">';
export const BA_JS = '<script src="/assets/js/before-after.js" defer></script>';
export const BA_FIELDS = ['before', 'after', 'service', 'caption', 'beforeLabel', 'afterLabel'];
export const CLIP_FIELDS = ['src', 'webm', 'poster', 'captions', 'title', 'width', 'height'];

const VIDEO_RE = /^\/assets\/video\/projects\/[\w.-]+\.mp4$/;
const WEBM_RE = /^\/assets\/video\/projects\/[\w.-]+\.webm$/;
const VTT_RE = /^\/assets\/video\/projects\/[\w.-]+\.vtt$/;
const POSTER_RE = /^\/assets\/images\/projects\/[\w.-]+\.(jpg|jpeg|webp)$/;
const LABEL_MAX = 16;

// QuickTime/MP4 location metadata: the classic user-data atom (©xyz) and the
// iPhone keys entry. Either means the file still says where the house is.
const LOCATION_MARKERS = [Buffer.from([0xa9, 0x78, 0x79, 0x7a]), Buffer.from('com.apple.quicktime.location')];
export const videoHasLocation = (buf) => LOCATION_MARKERS.some((m) => buf.indexOf(m) !== -1);

/**
 * Returns a list of error strings for one project's beforeAfter/clips.
 * `exists(src)` says whether a /assets/... path is on disk; `read(src)` returns
 * its bytes (only called for clip video files).
 */
export function mediaErrors(p, { exists, read = null } = {}) {
  const at = `project "${p.slug || '?'}"`;
  const errs = [];
  const photoSrcs = new Set((p.photos || []).map((ph) => ph.src));
  if (p.beforeAfter != null) {
    if (!Array.isArray(p.beforeAfter) || !p.beforeAfter.length) errs.push(`${at}: beforeAfter (optional) must be a non-empty list — omit it when the job has no true before/after pair`);
    else p.beforeAfter.forEach((ba, i) => {
      const w = `${at}: beforeAfter[${i}]`;
      if (!ba || typeof ba !== 'object') { errs.push(`${w}: must be an object`); return; }
      for (const k of Object.keys(ba)) if (!BA_FIELDS.includes(k)) errs.push(`${w}: unknown field "${k}"`);
      for (const k of ['before', 'after']) {
        if (!photoSrcs.has(ba[k])) errs.push(`${w}.${k}: "${ba[k]}" must be one of this job's photos[] (pairs reuse published, EXIF-stripped photos)`);
      }
      if (ba.before && ba.before === ba.after) errs.push(`${w}: before and after are the same photo`);
      if (!Array.isArray(p.services) || !p.services.includes(ba.service)) errs.push(`${w}.service: "${ba.service}" must be one of this job's services[] — the service the two photos actually show`);
      if (ba.caption != null && (typeof ba.caption !== 'string' || !ba.caption.trim())) errs.push(`${w}.caption (optional) must be a non-empty string`);
      for (const k of ['beforeLabel', 'afterLabel']) {
        if (ba[k] == null) continue;
        if (typeof ba[k] !== 'string' || !ba[k].trim() || ba[k].length > LABEL_MAX) errs.push(`${w}.${k} (optional) must be a short label, 1-${LABEL_MAX} characters`);
      }
    });
  }
  if (p.clips != null) {
    if (!Array.isArray(p.clips) || !p.clips.length) errs.push(`${at}: clips (optional) must be a non-empty list — omit it when the job has no clip`);
    else p.clips.forEach((c, i) => {
      const w = `${at}: clips[${i}]`;
      if (!c || typeof c !== 'object') { errs.push(`${w}: must be an object`); return; }
      for (const k of Object.keys(c)) if (!CLIP_FIELDS.includes(k)) errs.push(`${w}: unknown field "${k}"`);
      const need = [['src', VIDEO_RE], ['poster', POSTER_RE], ['captions', VTT_RE]];
      if (c.webm != null) need.push(['webm', WEBM_RE]);
      for (const [k, re] of need) {
        if (!re.test(c[k] || '')) errs.push(`${w}.${k}: "${c[k]}" must match ${re}`);
        else if (!exists(c[k])) errs.push(`${w}.${k}: ${c[k]} does not exist on disk`);
      }
      if (typeof c.title !== 'string' || !c.title.trim()) errs.push(`${w}.title: required — it is the clip's accessible name and caption`);
      for (const k of ['width', 'height']) if (!Number.isInteger(c[k]) || c[k] <= 0) errs.push(`${w}.${k}: the file's pixel ${k} (positive whole number)`);
      if (read) {
        for (const k of ['src', 'webm']) {
          if (c[k] == null || !(k === 'src' ? VIDEO_RE : WEBM_RE).test(c[k]) || !exists(c[k])) continue;
          if (videoHasLocation(read(c[k]))) errs.push(`${w}.${k}: ${c[k]} still carries location metadata — re-export it with the metadata stripped (runbooks/PUBLISH-PROJECT.md, "Job clips")`);
        }
      }
    });
  }
  return errs;
}

/** Default reader for mediaErrors: repo-root-relative docs path → bytes. */
export const docsReader = (root, path) => (src) => readFileSync(path.join(root, 'docs', src));

/**
 * One comparison figure. `pic(src, imgTag)` wraps an <img> in the page's
 * <picture> sources; `esc` escapes text; `p` is the project; `loc` is the
 * already-escaped location line (e.g. "Norwood, OH · 6 mi away"); `era` is an
 * already-built label (or ''); `eager` drops loading="lazy" (first figure
 * high on /our-work).
 */
export function baFigure({ p, ba, pic, esc, altOf, loc, era = '', eager = false, link = true }) {
  const bl = ba.beforeLabel || 'Before';
  const al = ba.afterLabel || 'After';
  const load = eager ? '' : ' loading="lazy"';
  const cell = (cls, src, label) => {
    const img = `<img src="${esc(src)}" alt="${esc(altOf(src))}"${load} decoding="async" width="800" height="600">`;
    return `<div class="bac-img ${cls}"><span class="bac-tag">${esc(label)}</span>${pic(src, img)}</div>`;
  };
  const title = link ? `<a href="/our-work/${esc(p.slug)}">${esc(p.title)}</a>` : esc(p.title);
  return `      <figure class="bac" data-bac data-before="${esc(bl)}" data-after="${esc(al)}">
        <div class="bac-frame">
          ${cell('bac-before', ba.before, bl)}
          ${cell('bac-after', ba.after, al)}
        </div>
        <figcaption class="bac-cap"><strong>${title}</strong>${ba.caption ? `${esc(ba.caption)}` : ''}<span class="bac-loc">${loc}${era}</span></figcaption>
      </figure>`;
}

/** One job clip: controls, muted, no autoplay, nothing loaded until played. */
export function clipFigure({ c, esc }) {
  return `      <figure class="bac-clip">
        <video controls muted playsinline preload="none" poster="${esc(c.poster)}" width="${c.width}" height="${c.height}" aria-label="${esc(c.title)}">${c.webm ? `
          <source src="${esc(c.webm)}" type="video/webm">` : ''}
          <source src="${esc(c.src)}" type="video/mp4">
          <track kind="captions" src="${esc(c.captions)}" srclang="en" label="English" default>
        </video>
        <figcaption>${esc(c.title)}</figcaption>
      </figure>`;
}
