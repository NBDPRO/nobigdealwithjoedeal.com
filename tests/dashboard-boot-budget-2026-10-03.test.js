/**
 * tests/dashboard-boot-budget-2026-10-03.test.js — a ratchet on what the CRM
 * dashboard loads at boot (audit 2026-10-03: ~4 MB of first-party JS over 178
 * script tags, 28 of them render-blocking, and nothing watching it grow).
 *
 * Counts every LOCAL <script src> in docs/pro/dashboard.html (lazy
 * ScriptLoader bundles aren't in the HTML, so they don't count — that's the
 * point of lazy-loading). Blocking = no defer, no async, not a module, and
 * NOT inside a <template>: view templates (tpl-view-settings, ...) are inert
 * markup until _hydrateViewTemplate swaps their <script>s into the live view
 * (an async=false dynamic insert), so they are not parser- or render-blocking.
 * CAVEAT, not "free": deep links (#/settings, ?settings=billing&connect=return,
 * ?est=, ?lead=, command-palette / agent-bots goTo('settings')) hydrate Settings
 * (~130 KB of template scripts) DURING boot and delay window load. They count
 * toward localScripts / localBytes, are bounded by their own ceiling
 * (templateScripts / templateBytes), and the "template-deferred" console line
 * below is the disclosure. The set of template scripts is pinned by name, so
 * a new one is a conscious change.
 * HTML is read with a small tokenizer (comments, raw-text bodies and quoted
 * attribute values are skipped; defer/async are attribute NAMES), not regexes
 * over the raw string.
 * Sizes are measured LF-only (CR bytes dropped) so a CRLF checkout and CI's LF
 * checkout agree to the byte.
 *
 * The blocking-script ceiling is strict: a new feature must load deferred or
 * lazily. The byte ceilings have a little headroom so ordinary work isn't
 * blocked, but steady growth trips the gate. Raising a ceiling is fine when
 * it's deliberate: change the number below in the same PR and say why.
 *
 * Run: node tests/dashboard-boot-budget-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PRO = path.join(__dirname, '..', 'docs', 'pro');
const CEILING = {
  blockingScripts: 22,          // measured 20 (2026-10-12, <template> scripts excluded; was 28 on 2026-10-03) — never grow. ONE deliberate raise 2026-10-06: demo-mode.js (Pro demo phase 2) must run before every other script so the sample account's guard + network tripwire exist first; on the real page it returns on line one (~9 KB)
  // 2026-10-12 (boot-weight lane): measured 170 KB LF once the 133 KB of <template>-inert
  // Settings/Draw/Estimate tab scripts stopped being counted as blocking (they were never
  // render-blocking; see measure()). Ceiling LOWERED 300 -> 192 KB so the gate still bites: ~22 KB
  // of real headroom, not 133 KB of slack. Was 300 KB measured 278 KB on 2026-10-03.
  blockingBytes: 192 * 1024,
  localScripts: 196,            // measured 178; deliberate raises 2026-10-05: + client-error-reporter.js (#2140, must run at boot to catch boot errors) + the offline sync badge (#2145) = 193 [+1 on merge: both PRs' boot tags, measured]; 2026-10-06 + storm-time.js (review R4-6-1: the one UTC→Eastern storm-date reader dol-fill + the D2D storm layer need at boot, 1.9 KB) = 195; +1 2026-10-07 demo-mode.js (Pro demo phase 2, #2294) = 196
  localBytes: 4.62 * 1024 * 1024, // deliberate raise 2026-10-12 (+0.02 MB): promise capture's Today rows + plan lanes in today-home.js / today-plan.js (~17 KB, deferred; the promise bundle itself is lazy, registered from today-home.js so blockingBytes does not move). (union of two deliberate raises, both 2026-10-11:4.4 + 0.05 + 0.15 MB.) deliberate raise 2026-10-11 (Ohio ORC 4722.04 cap: deposit-rule.js + the builder / invoice / deal-room / pre-flight wiring ~19 KB; LF bytes 4497 -> 4516 KB against the old 4506 KB) ALSO: deliberate raise 2026-10-11: per-theme My Skin backgrounds (my-skin.js 17 -> 49 KB, my-skin-logic.js 7 -> 22 KB: two-layer painter, IndexedDB cache, per-theme panel; all deferred, so blockingBytes is unchanged)
  htmlBytes: 520 * 1024,        // measured 477 KB
  templateScripts: 9,           // 2026-10-12: scripts inside <template> (hydrate with their view); also pinned by name below
  templateBytes: 136 * 1024,    // measured 130 KB LF
};
// The <template>-contained script set, pinned by name: adding to it is a conscious change (edit here).
const KNOWN_TEMPLATE_SCRIPTS = [
  'js/dashboard-accessory-panel-init.js', 'js/dashboard-billing-tab.js', 'js/dashboard-connect-tab.js',
  'js/dashboard-custom-theme.js', 'js/dashboard-hotkey-toggles.js', 'js/dashboard-insurance-overlay-toggle.js',
  'js/dashboard-sidebar-customizer.js', 'js/dashboard-team-tab.js', 'js/pipeline-builder.js',
];
// +1 local tag, deliberate (2026-10-05, #2155): js/photo-cache.js (window.NBDPhotoCache).
// It REPLACES the boot-time read of every photos doc, and its consumers (job-detail hero,
// Photos tab, photo hub, inspection report) read window.NBDPhotoCache
// synchronously behind a guard — lazy-loading it would turn a missing helper into silent
// "no photos" (page-scoped-helper rule). Kept as its own line so the other PRs that raise
// localScripts on the line above merge without a conflict.
CEILING.localScripts += 1;
// +1 local tag, deliberate (2026-10-13, phone quick wins re-slice of #2316): js/keyboard-viewport.js
// (2.9 KB). It keeps every open sheet above the iPhone keyboard (Record payment's Save sat under
// it); it must be listening before the first sheet opens, so it cannot be lazy. Own line.
CEILING.localScripts += 1;
// +1 local tag, deliberate (2026-10-11, C5): js/pipeline-rich-cards.js (window.NBDPipelineRich).
// crm-pipeline.js buildCard reads it synchronously when the board is in the rich density, and
// renderLeads paints the board strip through it — lazy-loading would paint the first board
// without the strip. Defer, no boot-time reads. Own line so parallel PRs raising the
// ceiling above merge without a conflict.
CEILING.localScripts += 1;
// +1 local tag, deliberate (2026-10-25, characters): js/chibi.js, the vector avatar the Home game card
// draws through (game-sprite.js reads window.NBDChibi synchronously when it draws; a lazy load would
// paint the pixel fallback first and the vector second). Defer, no boot-time reads. Own line.
CEILING.localScripts += 1;
// +8 KB, deliberate (2026-10-25, characters wave 2): chibi.js 28 -> 36 KB (jointed limbs, pose cross-fades,
// secondary motion, emotes, three poses). Deferred; blockingBytes does not move. Own line.
CEILING.localBytes += 8 * 1024;
CEILING.localBytes += 30 * 1024;   // pipeline-rich-cards.js = 26.5 KB (LF), + ~1 KB of hooks in crm-pipeline.js / dashboard-ui.js
// +1 local tag / +24 KB, deliberate (2026-10-11, layout system D0): js/layout-system.js — the
// layout registry + LayoutEngine in ONE deferred file (the preboot half rides inside the existing
// blocking shape-preboot.js, so blockingScripts does not move). It must be on every dashboard
// load: even a Classic rep needs the company default / lock read and the layoutchange event.
// Per-layout code and CSS (Field App, Focus, ...) load lazily only for the active layout.
CEILING.localScripts += 1;
CEILING.localBytes += 24 * 1024;
// +15 KB, deliberate (2026-10-13, Today UX walk PR-B; 10 -> 15 on the restack, main had absorbed ~5 KB of other PRs' bytes): no new script. The cold-boot "checking"
// state (collected-revenue.js, home-attention.js, today-home.js), the keyed handled set, the
// 6 s Undo on every Today action and the hold-then-collapse are ~14.7 KB of deferred code in
// files already loaded; promise-ui.js (lazy) and the CSS are not counted here. Own line.
CEILING.localBytes += 15 * 1024;
// +1 local tag, deliberate (2026-10-11, CRM style integration E1): js/pixel-mode.js (Pixel Mode loader, ~3 KB).
// Deferred; on boot it reads one settings doc and stops. The skin/Party/dialog code (pixel-mode-core.js), its CSS, the
// fonts and the logic module are fetched only when the person turned something on or the Settings card scrolls into
// view, and Pixel World (E2) is lazy-loaded from the core, so this is the only boot tag. (An earlier version shipped the
// whole 18 KB inline and pushed true LF bytes past the localBytes ceiling; the loader split is why it does not.)
CEILING.localScripts += 1;
// +1 local tag / +18 KB, deliberate (2026-10-13, visit recorder PR 1): js/visit-recorder-launcher.js
// (19.6 KB LF incl. comments, deferred, no boot-time reads). It owns only the ENTRY
// POINTS: the Home Record bar, the delegated Record button, today's appointment-row button, the
// deep link and the "is a recording still on this phone?" check (a localStorage counter, so
// IndexedDB is not opened on a normal boot). The recorder, its IndexedDB store, the screens and the
// stylesheet (visit-recorder*.js, css/visit-recorder.css, ~52 KB) are fetched ~4 s after the page
// settles (requestIdleCallback), so a recording started with no signal does not need the network
// to load its own code; none of it is on the boot path, so blockingScripts does not move. Own line.
CEILING.localScripts += 1;
CEILING.localBytes += 18 * 1024;
// +1 KB, deliberate (2026-10-14, SMS declined-consent policy, #2443): no new script tag. The consent-declined
// banner is customer.html-only; the ~1.2 KB that reaches the dashboard is deferred sms-outbox.js / nbd-comms.js /
// inbox.js hooks. Measured on main + #2450 + this PR: 4938704 B vs a 4938629 B ceiling (main alone 4935209 of 4936581,
// #2450 +2 KB line, this PR +1232 B), so the combined tree sat 75 B over; +1 KB restores ~0.9 KB headroom.
CEILING.localBytes += 1 * 1024;
// +3 KB, deliberate (2026-10-14, visit capture PR 2): the recorder launcher grows ~1 KB (the
// "unfiled capture" entry + attach hand-off) and visit-unfiled-today.js (~6 KB, deferred, loaded on
// the same idle schedule as the recorder, never on the boot path) is the Today "unfiled visit" row.
// Measured 4820 KB on the restack onto main (main alone: 4817 of 4818); ceiling keeps the same ~1 KB of slack.
CEILING.localBytes += 3 * 1024;
// +2 KB, deliberate (2026-10-14, send-email bound to a draft, #2450): no new script, no new tag. doc-drafts-ui.js
// (+~90 lines: the bound-send confirm + stale/ambiguous handling) and nbd-comms.js (+43 lines: the draftId
// hand-off) are deferred code that only runs when a draft is opened or sent. Main alone sat at 4820 of 4821 KB after
// #2449 (visit capture PR 2) consumed the last of the headroom, so this PR measures 4822 and the ceiling keeps ~1 KB.
CEILING.localBytes += 2 * 1024;
// +2 KB, deliberate (2026-10-16, layouts extras: storm strip + app badge): no new script, no new tag.
// home-attention.js (deferred, already on the page) sets the installed app's badge to the Needs-you count
// (+~1.2 KB: badgeCount + setAppBadge/clearAppBadge, a no-op where unsupported); script-loader.js registers
// the lazy 'homestrips' and 'stormstrip' bundles and today-home.js kicks them (+~0.8 KB); Field's old cached
// storm line went away (-0.3 KB, field.js is lazy anyway). Main + this stack measures 4845 of 4844 KB.
CEILING.localBytes += 2 * 1024;
// +2 KB, deliberate (2026-10-16, layouts extras: button size per layout + layout usage): no new script, no new
// tag. layout-system.js (deferred) learns density per layout (+~1.3 KB: cleanDensity, densityFor, applying it on
// every layout switch, saving it); shape-preboot.js stamps it before paint (+~0.3 KB); script-loader.js registers
// the lazy 'layoutusage' bundle (+~0.2 KB). Measured 4847 of 4846 KB.
CEILING.localBytes += 2 * 1024;
// +3 KB, deliberate (2026-10-16, layouts extras: review velocity): no new script, no new tag. home-attention.js
// (deferred) adds the reviews-in-30-days count and the "Draft a review ask" sms: draft to the Needs-you chip
// (+~2.2 KB: reviewVelocity, reviewAskBody, the chip markup); numbers-data.js says whether the Google read
// answered (+~0.3 KB); review-engine.js exports its review link (+~0.1 KB). Field's wrap-up is in the lazy
// field.js. Measured 4850 of 4848 KB.
CEILING.localBytes += 3 * 1024;
// +5 KB, deliberate (2026-10-15, siding warranty by package, #2463 + its follow-up): no new script tag.
// The siding kind + package table in estimate-config.js and customer-estimate-rows.js (both deferred),
// the Package row in job-templates-ui.js, the signed-package lock and the certificate's signed view in
// doc-preflight.js. Main sat at 4823 of 4824 KB; this PR measures 4828, so the ceiling keeps ~1 KB of slack.
CEILING.localBytes += 5 * 1024;
// +6 KB, deliberate (2026-10-15, CRM layouts + Home + Record visit, Joe's phone pass): no new script, no new tag.
// layout-system.js (+~2 KB: the fallback-to-Classic path and its toast, the DOMContentLoaded boot), the recorder
// launcher (+~1.5 KB: Record bar only in Classic/Bento, the room it reserves, one label), today-home.js (+~1.3 KB:
// the big-day headline, the plain old-calls line) and standalone-compat.js (+~0.5 KB) are deferred code already on
// the page; pixel-mode.js shrank ~1.4 KB (no layout seam). The launcher also gained the "Recent visits" entry
// beside Record (+~1.5 KB, delegated, lazy-loads the recorder like Record). Measured 4834 KB on main + #2463
// (ceiling 4829 before this line); the ceiling keeps ~1 KB of slack. The layout files themselves are lazy and not counted here.
CEILING.localBytes += 6 * 1024;
// +1 KB, deliberate (2026-10-15, speed-to-lead missed-call reply, #2470): no new script, no new tag. notif-bell.js
// (deferred, already on the page) gains the "Text back" link for a missed call's prefilled sms: draft (+~0.7 KB:
// one shape-check regex, the smsHref field, the link markup). call-center-view.js is lazy and not counted here.
// Main sat at 4834 of 4835 KB; this PR measures 4835, so the ceiling keeps ~1 KB of slack.
CEILING.localBytes += 1 * 1024;
// +6 KB, deliberate (2026-10-15, CRM layouts audit fixes): no new script, no new tag. phone-share.js gains the one
// delegated "ok to text?" hold for <a href="sms:" data-ps-check> drafts (+~1.9 KB, D16); layout-system.js fails
// closed and retries when the settings read fails with no cache (+~2.4 KB, D14); dashboard-state.js loads the theme
// engine at boot when the phone prefers light (+~0.9 KB, D21). All deferred code already on the page. Main sat at
// 4836 of 4836 KB; this PR measures 4841, so the ceiling keeps ~1 KB of slack.
CEILING.localBytes += 6 * 1024;
// +2 KB, deliberate (2026-10-15, layouts N1 + N2: Next stop and Cash cards): no new script, no new tag. Both
// cards are lazy ScriptLoader bundles ('nextstop', 'cashcard'); what counts here is their registration in
// script-loader.js (+~1 KB of bundle lists and comments), today-home.js exposing its appointment rows and
// kicking the bundles (+~0.6 KB) and the Settings goal panel's markup lives in dashboard.html (html, not
// scripts). Main sat at 4842 of 4842 KB with the Next stop card; this PR measures 4843.
CEILING.localBytes += 2 * 1024;
// +3 KB, deliberate (2026-10-16, Revenue tile goal = the Cash card's rule): no new script, no new tag. widgets.js
// (deferred, already on the page) drops the assumed $50k goal and gains the "Set a goal" link to Settings >
// Profile plus the nbd:monthly-goal repaint (+~2.2 KB). Main sat at 4851 of 4851 KB; this PR measures 4853,
// so the ceiling keeps ~1 KB of slack.
CEILING.localBytes += 3 * 1024;
// +3 KB, deliberate (2026-10-16, warranty locks): no new script, no new tag. warranty-cert.js (deferred,
// lazy with the Docs view) reads the lead's estimate for the certificate's tier / package / job-type years
// (+~4 KB LF); customer-estimate-rows.js locks repairWarranty at signing (+~1 KB). Measured 4855 of 4854 KB,
// so the ceiling keeps ~2 KB of slack.
CEILING.localBytes += 3 * 1024;
// +1 local tag / +26 KB, deliberate (2026-10-19, bulk close stale leads): js/stale-leads-cleanup.js (deferred, flag
// bulkCloseStaleLeads, absent = off). No boot-time reads; with the flag off it only keeps the toolbar button hidden. Own line.
CEILING.localScripts += 1;
CEILING.localBytes += 26 * 1024;
// +1 local tag, deliberate (2026-10-19, Messaging Control Center): js/messaging-nav.js (deferred, ~1 KB, flag
// messagingControlCenter, absent = off). It only un-hides two menu entries for owner/admin; the view itself is the lazy
// 'messaging' ScriptLoader bundle. No boot-time reads. Own lines.
CEILING.localScripts += 1;
CEILING.localBytes += 2 * 1024;
// +1 local tag / +16 KB, deliberate (2026-10-19, Where customers came from): js/lead-source-fixer.js (deferred, flag
// leadSourceFixer, absent = off). No boot-time reads: invoices and spend load only when the modal opens. Own line.
CEILING.localScripts += 1;
CEILING.localBytes += 16 * 1024;
// +1 local tag / +20 KB, deliberate (2026-10-19, Reputation): js/reputation.js (deferred, flag reputationLoop, absent = off).
// No boot-time reads; with the flag off it only keeps the toolbar button hidden. Own line.
CEILING.localScripts += 1;
CEILING.localBytes += 20 * 1024;
// +1 local tag / +16 KB, deliberate (2026-10-19, speed to lead): js/speed-to-lead.js (deferred, flag speedToLead,
// absent = off). No boot-time reads; with the flag off it only keeps the toolbar button hidden. Own line.
CEILING.localScripts += 1;
CEILING.localBytes += 16 * 1024;
// +1 local tag / +16 KB, deliberate (2026-10-19, estimate follow-up board): js/estimate-follow-board.js (deferred, flag
// estimateFollowBoard, absent = off). No boot-time reads; with the flag off it only keeps the toolbar button hidden. Own line.
CEILING.localScripts += 1;
CEILING.localBytes += 16 * 1024;

// ── SHIPPED BYTES (2026-10-16, deploy-time minify) ─────────────────────────
// Since the deploy minifies docs/pro with esbuild (scripts/minify-shipped.js:
// whitespace + syntax only, no renaming), the readable bytes above are not
// what a phone downloads. The BYTE gates now measure the minified bytes that
// ship: each local script is run through the same minifySource() the deploy
// uses. The readable-source numbers above (CEILING.blockingBytes /
// localBytes / templateBytes, and the += history) are still measured and
// printed so growth stays visible, but they no longer fail the test. Raise
// a SHIPPED ceiling below, in the same PR and with a reason, the same way.
//   measured 2026-10-16 on main e1433a7e (202 boot scripts):
//     local    4854 KB readable -> 2654 KB shipped (gzip 1557 -> 856 KB, brotli 1321 -> 743 KB)
//     blocking  175 KB readable ->   78 KB shipped
//     template  130 KB readable ->   69 KB shipped
// (keepNames' __name() calls cost ~150 KB raw of that; they are what keeps fn.name right.)
// Ceilings keep ~5% headroom over that, so steady growth still trips them.
// The script COUNT ceilings above are unchanged and still enforced.
// esbuild must be the pinned version: `node scripts/minify-shipped.js --install`.
// Without it the shipped gates fail under CI (process.env.CI) and are skipped
// with a warning on a laptop, where the readable gates are enforced instead.
const SHIPPED_CEILING = {
  blockingBytes: 84 * 1024,   // deliberate raise 2026-10-24 (82 -> 84 KB): demo-mode.js is the dashboard's first, synchronous script and now routes the sample account's tool pages (window.open + tracker remap, SANDBOX_TOOLS, insurance-topic hiding); measured 84093 B shipped
  localBytes: 2816 * 1024, // deliberate raise 2026-10-25 (2790 -> 2798 KB): chibi.js wave 2 (jointed limbs, pose cross-fades, emotes), deferred; (2798 -> 2804 KB, later the same day): characters wave 11, the Roof Rep looks on the dashboard; (2804 -> 2816 KB, same day): character waves 12-17 (builds, gaze, pop-in, cold breath, eye colour, two poses) grew chibi.js from 47 to 56 KB and game-sprite.js by 0.4 KB, all deferred; measured 2804 of 2804 before the raise leaderboards (team-names.js avatars, the Leaderboard view and the widget), ~3 KB minified, all deferred
  templateBytes: 73 * 1024,
};

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// Size with CR bytes dropped, so CRLF-checkout numbers equal CI's LF numbers.
function lfSize(file) {
  const b = fs.readFileSync(file);
  let n = 0;
  for (let i = 0; i < b.length; i++) if (b[i] !== 13) n++;
  return n;
}
// Minimal HTML tag tokenizer. Skips comments (even ones opened inside text), <!doctype>,
// raw-text bodies (script/style/textarea/title) and quoted attribute values, so a stray
// "<template>" or "<!--" inside an attribute or a JS string cannot desync the scan.
// Attributes land in a null-prototype map (first occurrence wins, names lower-cased).
function tokenizeTags(html) {
  const tags = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    const c = html[lt + 1] || '';
    if (c === '!' || c === '?') { const e = html.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (!/[A-Za-z\/]/.test(c)) { i = lt + 1; continue; }
    let j = lt + 1;
    const closing = html[j] === '/';
    if (closing) j++;
    const ns = j;
    while (j < n && !/[\s\/>]/.test(html[j])) j++;
    const name = html.slice(ns, j).toLowerCase();
    const attrs = Object.create(null);
    while (j < n && html[j] !== '>') {
      if (/[\s\/]/.test(html[j])) { j++; continue; }
      const as = j;
      while (j < n && !/[\s=\/>]/.test(html[j])) j++;
      const an = html.slice(as, j).toLowerCase();
      while (j < n && /\s/.test(html[j])) j++;
      let val = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        if (html[j] === '"' || html[j] === "'") {
          const q = html[j];
          const e = html.indexOf(q, j + 1);
          val = html.slice(j + 1, e < 0 ? n : e);
          j = e < 0 ? n : e + 1;
        } else {
          const vs = j;
          while (j < n && !/[\s>]/.test(html[j])) j++;
          val = html.slice(vs, j);
        }
      }
      if (an && !(an in attrs)) attrs[an] = val;
    }
    i = j + 1;
    tags.push({ name, closing, attrs, index: lt });
    if (!closing && /^(script|style|textarea|title)$/.test(name)) {
      const re = new RegExp('</' + name + '[\\s>/]', 'ig');
      re.lastIndex = i;
      const m = re.exec(html);
      i = m ? m.index : n;
    }
  }
  return tags;
}
// The deploy's own minifier (null when the pinned esbuild is not installed).
const MINIFY = require('../scripts/minify-shipped.js');
let ESBUILD = null, ESBUILD_ERR = '';
try { ESBUILD = MINIFY.loadEsbuild(); } catch (e) { ESBUILD_ERR = e.message; }
// Bytes the deploy actually serves for this file: minified when the deploy minifies it.
function shippedSize(file) {
  const rel = path.relative(path.join(__dirname, '..', 'docs'), file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  if (!MINIFY.shouldMinify(rel)) return Buffer.byteLength(src);
  return Buffer.byteLength(MINIFY.minifySource(ESBUILD, src, rel, false).code);
}
function measure(html, root) {
  const out = {
    htmlBytes: Buffer.byteLength(html.replace(/\r/g, '')), localScripts: 0, localBytes: 0, blockingScripts: 0, blockingBytes: 0,
    templateBlockingScripts: 0, templateBlockingBytes: 0, templateFiles: [], tplDepthAtEof: 0, strayTemplateClose: 0, missing: [],
    shippedLocalBytes: 0, shippedBlockingBytes: 0, shippedTemplateBytes: 0,
  };
  let tplDepth = 0;
  for (const t of tokenizeTags(html)) {
    if (t.name === 'template') {
      if (!t.closing) tplDepth++;
      else if (tplDepth > 0) tplDepth--;
      else out.strayTemplateClose++;
      continue;
    }
    if (t.name !== 'script' || t.closing) continue;
    const src = t.attrs.src;
    if (!src || /^(https?:)?\/\//i.test(src)) continue;
    const rel = src.split('?')[0];
    const file = path.join(root, rel.replace(/^\/pro\//, ''));
    if (!fs.existsSync(file)) { out.missing.push(src); continue; }
    const n = lfSize(file);
    const s = ESBUILD ? shippedSize(file) : 0;
    out.localScripts++; out.localBytes += n; out.shippedLocalBytes += s;
    const blocking = !('defer' in t.attrs) && !('async' in t.attrs) && String(t.attrs.type || '').toLowerCase() !== 'module';
    if (blocking && tplDepth > 0) { out.templateBlockingScripts++; out.templateBlockingBytes += n; out.shippedTemplateBytes += s; out.templateFiles.push(rel); }
    else if (blocking) { out.blockingScripts++; out.blockingBytes += n; out.shippedBlockingBytes += s; }
  }
  out.tplDepthAtEof = tplDepth;
  return out;
}
console.log('\nDASHBOARD BOOT BUDGET');
const m = measure(fs.readFileSync(path.join(PRO, 'dashboard.html'), 'utf8'), PRO);
const kb = (n) => Math.round(n / 1024) + ' KB';
// Readable-source byte gates: enforced only when the shipped gates cannot run (laptop without esbuild).
const SHIPPED_GATES = !!ESBUILD;
function srcBytes(name, got, ceil) {
  if (SHIPPED_GATES) console.log('  · readable ' + name + ': ' + kb(got) + ' (history ceiling ' + kb(ceil) + ', informational: the shipped gate below is enforced)');
  else ok('readable ' + name + ': ' + kb(got) + ' ≤ ' + kb(ceil), got <= ceil);
}
ok('every local script tag resolves to a file', m.missing.length === 0, m.missing.join(', '));
ok('blocking scripts: ' + m.blockingScripts + ' ≤ ' + CEILING.blockingScripts + ' (new code loads deferred or lazily)', m.blockingScripts <= CEILING.blockingScripts);
srcBytes('blocking bytes', m.blockingBytes, CEILING.blockingBytes);
console.log('  · template-deferred (not parser-blocking; hydrate with their view, ON BOOT for deep links like #/settings): ' + m.templateBlockingScripts + ' scripts, ' + kb(m.templateBlockingBytes));
ok('template-deferred scripts: ' + m.templateBlockingScripts + ' ≤ ' + CEILING.templateScripts, m.templateBlockingScripts <= CEILING.templateScripts);
srcBytes('template-deferred bytes', m.templateBlockingBytes, CEILING.templateBytes);
ok('<template> tags balance to depth 0 at EOF, no stray </template> (else every later script is misfiled)', m.tplDepthAtEof === 0 && m.strayTemplateClose === 0,
  'depth ' + m.tplDepthAtEof + ', stray closes ' + m.strayTemplateClose);
ok('template-deferred set is exactly the known set (a new template script is a conscious change)',
  JSON.stringify(m.templateFiles.slice().sort()) === JSON.stringify(KNOWN_TEMPLATE_SCRIPTS.slice().sort()),
  'got: ' + m.templateFiles.slice().sort().join(', '));
ok('local script tags: ' + m.localScripts + ' ≤ ' + CEILING.localScripts, m.localScripts <= CEILING.localScripts);
srcBytes('local script bytes', m.localBytes, CEILING.localBytes);
ok('dashboard.html: ' + kb(m.htmlBytes) + ' ≤ ' + kb(CEILING.htmlBytes), m.htmlBytes <= CEILING.htmlBytes);

console.log('\nSHIPPED (minified at deploy, scripts/minify-shipped.js)');
if (!SHIPPED_GATES) {
  const why = 'esbuild ' + MINIFY.ESBUILD_VERSION + ' not available' + (ESBUILD_ERR ? ' (' + ESBUILD_ERR + ')' : '') + ': run node scripts/minify-shipped.js --install';
  if (process.env.CI) ok('shipped-byte gates can run (pinned esbuild installed)', false, why);
  else console.log('  ! SKIPPED: ' + why + ' (the readable gates above were enforced instead)');
} else {
  ok('shipped blocking bytes: ' + kb(m.shippedBlockingBytes) + ' ≤ ' + kb(SHIPPED_CEILING.blockingBytes), m.shippedBlockingBytes <= SHIPPED_CEILING.blockingBytes);
  ok('shipped template-deferred bytes: ' + kb(m.shippedTemplateBytes) + ' ≤ ' + kb(SHIPPED_CEILING.templateBytes), m.shippedTemplateBytes <= SHIPPED_CEILING.templateBytes);
  ok('shipped local script bytes: ' + kb(m.shippedLocalBytes) + ' ≤ ' + kb(SHIPPED_CEILING.localBytes), m.shippedLocalBytes <= SHIPPED_CEILING.localBytes);
  // Controls: the shipped measure really is the minified output, and minifying keeps what the CRM relies on.
  ok('control: shipped bytes are the minified bytes (well under the readable bytes)', m.shippedLocalBytes > 0 && m.shippedLocalBytes < m.localBytes * 0.8,
    kb(m.shippedLocalBytes) + ' vs ' + kb(m.localBytes));
  // A fixed probe (not a real file), evaluated after minifying: every .name the CRM can observe.
  const probe = "'use strict';\nfunction debounce(fn){ return fn.name; } // crm-leads.js keys timers on fn.name\n" +
    "const w = {};\nw.saveNote = function saveNote() {};\nconst a = function b() {};\nconst o = { x: function b() {} };\nclass Klass { m() { return Klass; } }\n" +
    "const PROBE = [debounce(function save() {}), w.saveNote.name, a.name, o.x.name, Klass.name, typeof debounce];\n";
  const WANT = 'save,saveNote,b,b,Klass,function';
  const run = (code) => { try { return new Function(code + '\nreturn PROBE.join();')(); } catch (e) { return String(e); } };
  const out = MINIFY.minifySource(ESBUILD, probe, 'pro/js/probe.js', false).code;
  ok('control: minified code keeps every function and class .name (keepNames) and the top-level names', run(out) === WANT, run(out) + ' :: ' + out);
  ok('control: no class static {} block in the output (a syntax error before Safari 16.4)', !/static\s*\{/.test(out), out);
  // The same probe without keepNames really loses names, so the check above can fail.
  const bare = ESBUILD.transformSync(probe, Object.assign({}, MINIFY.OPTIONS, { loader: 'js', keepNames: false })).code;
  ok('control: without keepNames esbuild drops names (the reason keepNames is on)', run(bare) !== WANT, run(bare));
}

// Positive controls: the counter must see what it claims to count.
const ctl = measure('<script src="js/a.js"></script><script defer src="js/a.js"></script><script type="module" src="js/a.js"></script><!-- <script src="js/a.js"></script> --><script src="https://x.test/b.js"></script>', path.join(__dirname));
ok('control: counts local tags, skips CDN + commented-out tags, splits blocking from deferred/module',
  ctl.blockingScripts === 0 && ctl.missing.length === 3 && ctl.localScripts === 0);
const real = measure('<script src="dashboard-boot-budget-2026-10-03.test.js"></script><script defer src="dashboard-boot-budget-2026-10-03.test.js"></script>', __dirname);
ok('control: a blocking tag and a deferred tag are told apart', real.localScripts === 2 && real.blockingScripts === 1);
const tplCtl = measure('<script src="dashboard-boot-budget-2026-10-03.test.js"></script><template id="a"><div><template><script src="dashboard-boot-budget-2026-10-03.test.js"></script></template><script src="dashboard-boot-budget-2026-10-03.test.js"></script></div></template><script src="dashboard-boot-budget-2026-10-03.test.js"></script>', __dirname);
ok('control: <template>-contained blocking tags (nested too) are not boot-blocking, but still count as local scripts; tags after the template block again',
  tplCtl.localScripts === 4 && tplCtl.blockingScripts === 2 && tplCtl.templateBlockingScripts === 2 && tplCtl.blockingBytes === tplCtl.templateBlockingBytes);
ok('control: the real page really has template-deferred scripts (the exclusion is exercised)', m.templateBlockingScripts >= 5);
// Tokenizer controls: each of these desynced the previous regex scan (or hid a tag from it).
const T = 'dashboard-boot-budget-2026-10-03.test.js';
const c1 = measure('<div title="<template>"></div><script src="' + T + '"></script>', __dirname);
ok('control: a "<template>" inside an attribute value does not swallow later scripts', c1.blockingScripts === 1 && c1.tplDepthAtEof === 0);
const c2 = measure('<script>var s = "<template>";</script><script src="' + T + '"></script>', __dirname);
ok('control: "<template>" inside an inline script body is ignored', c2.blockingScripts === 1 && c2.tplDepthAtEof === 0);
const c3 = measure('<script src="' + T + '" data-async-note="1" id="async-loader"></script><script src="' + T + '?mode=defer"></script>', __dirname);
ok('control: "async"/"defer" inside another attribute or the src query do not make a script non-blocking', c3.blockingScripts === 2);
const c4 = measure("<script src='" + T + "'></script><script src=" + T + "></script><script defer src=" + T + "></script><script async src='" + T + "'></script>", __dirname);
ok('control: single-quoted and unquoted src are seen; bare defer/async attributes still make them non-blocking',
  c4.localScripts === 4 && c4.blockingScripts === 2);
const c5 = measure('<div title="<!--"></div><script src="' + T + '"></script>', __dirname);
ok('control: "<!--" inside an attribute does not swallow later tags', c5.blockingScripts === 1);
const c6 = measure('<template><script src="' + T + '"></script>', __dirname);
ok('control: an unclosed <template> is detected (depth != 0 at EOF)', c6.tplDepthAtEof === 1);

// ── BOOT READS (2026-10-04) ────────────────────────────────────────────────
// Bytes are half the boot cost; Firestore reads are the other half. The boot
// read path is loadLeads + the post-auth tail it triggers (loadPins,
// loadZones). Every collection read there must be BOUNDED (limit(...)) — the
// one deliberate exception is that leads page through the WHOLE book (500 a
// page, the kanban must be complete), which carries limit(_PAGE) per page.
//   measured 2026-10-03 (before): 3 unbounded boot reads — photos (every doc
//     in scope, own + company), pins, zones;
//   measured 2026-10-04 (after):  0 — photos load per lead on demand
//     (js/photo-cache.js), pins capped to the newest PIN_CAP, zones to ZONE_CAP.
// The runtime twin is tests/e2e/boot-weight.spec.js "boot reads", which
// counts the queries the SDK actually starts. Ceiling: never grow.
console.log('\nDASHBOARD BOOT READS');
const UNBOUNDED_BOOT_READS_CEILING = 0;
function bootReadCalls(src) {
  const fnBody = (name, endMarker) => {
    const a = src.indexOf('async function ' + name + '(');
    if (a < 0) return '';
    const b = src.indexOf(endMarker, a);
    return src.slice(a, b < 0 ? a + 20000 : b);
  };
  const bodies = [
    fnBody('loadLeads', 'window._loadLeads = loadLeads'),
    fnBody('loadPins', 'async function _savePin'),
    fnBody('loadZones', 'window.loadZones = loadZones'),
  ].map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
  const calls = [];
  for (const body of bodies) {
    for (const m of body.matchAll(/getDocs\(\s*query\(\s*collection\(\s*db\s*,\s*'([\w-]+)'([^;]*)/g)) {
      calls.push({ coll: m[1], bounded: /\blimit\(/.test(m[2]) });
    }
  }
  return { found: bodies.every(Boolean), calls };
}
const br = bootReadCalls(fs.readFileSync(path.join(PRO, 'js', 'dashboard-bootstrap.module.js'), 'utf8'));
const unbounded = br.calls.filter((c) => !c.bounded);
ok('found loadLeads / loadPins / loadZones', br.found);
ok('boot read calls located (' + br.calls.length + ')', br.calls.length >= 3);
ok('unbounded boot reads: ' + unbounded.length + ' ≤ ' + UNBOUNDED_BOOT_READS_CEILING + ' (was 3: photos, pins, zones)',
  unbounded.length <= UNBOUNDED_BOOT_READS_CEILING, unbounded.map((c) => c.coll).join(', '));
ok('no photos read anywhere on the boot path', !br.calls.some((c) => c.coll === 'photos'));
const ctlReads = bootReadCalls("async function loadLeads() { await getDocs(query(collection(db,'photos'), s)); }\nwindow._loadLeads = loadLeads\nasync function loadPins() { getDocs(query(collection(db,'pins'), s, limit(5))); }\nasync function _savePin\nasync function loadZones() {}\nwindow.loadZones = loadZones");
ok('control: an unbounded read is counted, a limit()ed one is not', ctlReads.calls.length === 2 && ctlReads.calls.filter((c) => !c.bounded).length === 1);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
