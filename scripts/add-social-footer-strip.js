#!/usr/bin/env node
/**
 * Adds a social-media icon strip to every page's footer, next to the
 * Privacy link (which phase C dropped in). Ten chips, branded hover
 * colors: Facebook, Instagram, Google (GBP share link), Yelp. Six more
 * (YouTube, TikTok, Pinterest, Threads, Houzz, Nextdoor) joined 2026-11-16;
 * their hover colors and the wrap rule live in nbd-mobile.css.
 *
 * The HTML is idempotent — it checks for the `data-nbd-social="v1"`
 * marker and skips files that already carry it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const SKIP_DIRS = new Set(['admin', 'pro', 'sites', 'assets', 'deploy', 'tools']);

const URLS = {
  facebook: 'https://www.facebook.com/people/No-Big-Deal-Home-Solutions/61577416645584/',
  instagram: 'https://www.instagram.com/nbdhomesolutions',
  google: 'https://share.google/dHlqknguidMfhTFS9',
  yelp: 'https://www.yelp.com/biz/no-big-deal-home-solutions-cincinnati',
};

const SOCIAL_CSS_MARKER = '/* nbd-social-v1 */';
const SOCIAL_CSS = `<style>
${SOCIAL_CSS_MARKER}
.nbd-social{display:inline-flex;gap:10px;align-items:center;margin-left:14px;vertical-align:middle}
.nbd-social a{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);text-decoration:none!important;transition:transform .2s,background .2s,color .2s}
.nbd-social a:hover{transform:translateY(-2px);color:#fff}
.nbd-social a.s-fb:hover{background:#1877f2}
.nbd-social a.s-ig:hover{background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)}
.nbd-social a.s-gg:hover{background:#4285f4}
.nbd-social a.s-yelp:hover{background:#d32323}
.nbd-social svg{width:15px;height:15px;display:block}
@media(max-width:640px){.nbd-social{margin-left:0;margin-top:8px;display:flex;gap:8px}}
footer.foot .nbd-social a,.review-footer .nbd-social a{background:rgba(255,255,255,.1)}
</style>`;

const MARKER = 'data-nbd-social="v1"';
const SOCIAL_HTML = ` <span class="nbd-social" ${MARKER}>
  <a class="s-fb" href="${URLS.facebook}" target="_blank" rel="noopener" aria-label="Facebook"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 22v-8h2.6l.4-3H13V9.1c0-.9.2-1.5 1.4-1.5H16V5c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1V11H7v3h2.6v8H13z"/></svg></a>
  <a class="s-ig" href="${URLS.instagram}" target="_blank" rel="noopener" aria-label="Instagram"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none"/></svg></a>
  <a class="s-gg" href="${URLS.google}" target="_blank" rel="noopener" aria-label="Google Business Profile"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.6 12.23c0-.68-.06-1.34-.17-1.98H12v3.75h5.4a4.62 4.62 0 0 1-2 3.03v2.52h3.24c1.9-1.74 3-4.3 3-7.32zM12 22c2.7 0 4.97-.9 6.63-2.44l-3.24-2.52c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.6-4.13H3.05v2.6A10 10 0 0 0 12 22zm-5.6-7.13A6 6 0 0 1 6.08 12c0-.99.17-1.95.44-2.87V6.53H3.05A10 10 0 0 0 2 12c0 1.6.39 3.14 1.05 4.47l3.35-2.6zM12 5.88c1.47 0 2.8.5 3.84 1.5l2.88-2.88A10 10 0 0 0 12 2 10 10 0 0 0 3.05 7.53l3.35 2.6C7.18 7.63 9.39 5.88 12 5.88z"/></svg></a>
  <a class="s-yelp" href="${URLS.yelp}" target="_blank" rel="noopener" aria-label="Yelp"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.6 12.6c0-.4-.2-.7-.5-.8L6.5 10.1c-.5-.2-1.1.2-1.1.8l.1 5.5c0 .7.7 1.1 1.3.8l4.5-2.9c.2-.2.3-.5.3-.8v-.9zm1.8 1c-.3-.2-.6-.1-.8.1L9.4 17c-.4.4-.2 1 .3 1.1l4.4 1.2c.6.1 1.1-.5 1-1.1l-1-3.8c-.1-.3-.3-.5-.7-.8zm-2.7-5.5c.4-.2.6-.6.5-1l-.8-4.4c-.1-.6-.8-.9-1.3-.5L5.6 4.9c-.5.4-.4 1.1.1 1.4l4.4 2c.2 0 .4 0 .6-.2zm5 3.6L14.4 9c-.3-.4-.9-.3-1.1.2l-1.2 3.8c-.2.5.2 1 .7 1l4.2.3c.7.1 1-.8.5-1.3l-1.8-1.3zm-.6 3.4c-.4-.2-1 .1-1.1.6l-.5 4c-.1.6.5 1 1 .8l3.9-1.6c.6-.2.6-1 .1-1.4l-3.4-2.4z"/></svg></a>
  <a class="s-yt" href="https://www.youtube.com/@nobigdealhomesolutions" target="_blank" rel="noopener" aria-label="YouTube"><svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4a2.5 2.5 0 0 0-1.8 1.8C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3L10 15z"/></svg></a>
  <a class="s-tt" href="https://www.tiktok.com/@nobigdealhomesolutions" target="_blank" rel="noopener" aria-label="TikTok"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.6 3c.3 2.2 1.6 3.6 3.8 3.8v3.1c-1.4.1-2.6-.3-3.8-1v6c0 3.4-2.6 5.6-5.6 5.6A5.5 5.5 0 0 1 5.5 15c0-3.3 2.9-5.8 6.3-5.3v3.2c-1.6-.4-3.2.6-3.2 2.2 0 1.3 1 2.4 2.4 2.4 1.5 0 2.4-1 2.4-2.6V3h3.2z"/></svg></a>
  <a class="s-pin" href="https://www.pinterest.com/nobigdealhomesolutions/" target="_blank" rel="noopener" aria-label="Pinterest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10.2 21l2.1-9"/><path d="M8.4 14.2C7.4 10 10 6.5 13.4 6.5c2.8 0 4.6 2 4.6 4.6 0 3-1.8 5.4-4.3 5.4-1.3 0-2.2-.8-2-1.9"/></svg></a>
  <a class="s-th" href="https://www.threads.com/@nbdhomesolutions" target="_blank" rel="noopener" aria-label="Threads"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.4"/><path d="M15.4 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.2 8.2 0 1 0-3.3 6.6"/></svg></a>
  <a class="s-hz" href="https://www.houzz.com/pro/webuser_74770817020" target="_blank" rel="noopener" aria-label="Houzz"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 2v20h5.2v-6h3.6v6H19V10.4L9.4 7.6V2H5z"/></svg></a>
  <a class="s-nd" href="https://nextdoor.com/pages/no-big-deal-home-solutions-cincinnati-oh/" target="_blank" rel="noopener" aria-label="Nextdoor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M7.5 20v-5.5a4.5 4.5 0 0 1 9 0V20"/></svg></a>
</span>`;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Pages that LINK the extracted stylesheet already have these rules; the
// marker is gone from them by design, so a marker-only guard would re-inline
// the block into all 192 of them the next time this script runs. Same stale-
// generator trap that fix-trust-icons.js (#1671) and injectTypography (#1674)
// hit after their blocks were extracted. See scripts/ensure-social-css.js,
// whose CI assert fails on exactly that re-injection.
const SOCIAL_CSS_LINK = '/assets/css/nbd-social.css';

function injectCss(html) {
  if (html.includes(SOCIAL_CSS_MARKER) || html.includes(SOCIAL_CSS_LINK)) return { html, changed: false };
  const idx = html.lastIndexOf('</head>');
  if (idx < 0) return { html, changed: false };
  return { html: html.slice(0, idx) + SOCIAL_CSS + '\n' + html.slice(idx), changed: true };
}

function injectSocial(html) {
  if (html.includes(MARKER)) return { html, changed: false };
  // Anchor off the Privacy link closing </a> — it's unique per page and
  // only appears inside footers.
  const anchor = 'data-nbd-privacy="1" style="color:inherit;text-decoration:none">Privacy</a>';
  const i = html.indexOf(anchor);
  if (i < 0) return { html, changed: false };
  const inject = i + anchor.length;
  return { html: html.slice(0, inject) + SOCIAL_HTML + html.slice(inject), changed: true };
}

const stats = { scanned: 0, cssInjected: 0, socialInjected: 0, untouched: 0 };
const samples = [];

for (const file of walk(ROOT)) {
  stats.scanned++;
  let html = fs.readFileSync(file, 'utf8');
  let changed = false;

  const css = injectCss(html);
  if (css.changed) { html = css.html; changed = true; stats.cssInjected++; }

  const soc = injectSocial(html);
  if (soc.changed) {
    html = soc.html;
    changed = true;
    stats.socialInjected++;
    if (samples.length < 3) samples.push(path.relative(ROOT, file));
  }

  if (changed) fs.writeFileSync(file, html);
  else stats.untouched++;
}

console.log(JSON.stringify({ stats, samples }, null, 2));
