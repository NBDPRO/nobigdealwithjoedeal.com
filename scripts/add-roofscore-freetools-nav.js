#!/usr/bin/env node
/*
 * Roof Score (a fully-built lead tool) has zero internal links anywhere on
 * the site, and the new /free-tools hub needs a nav entry to be findable.
 * This inserts both into the desktop Services-dropdown and mobile Tools
 * group wherever the site's current "storm tools" cluster already lives
 * (164 pages desktop / 155 pages mobile — the common template cohort;
 * blog was already handled by sync-blog-nav.js). Also adds the missing
 * mobile /inspect link (currently on 0 of 212 pages) while touching this
 * exact block, since it's the same fix location.
 *
 * A ~20-30 page long tail (the funnel tool pages themselves, premium
 * component sub-pages, and the generic non-city service hub pages, which
 * use a shorter nav variant) is NOT covered by this pass — see the
 * uncovered[] report at the end.
 *
 * Idempotent: skips any file that already links to /roof-score.
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['admin', 'pro', 'sites', 'assets', 'deploy', 'blog'].includes(e.name)) return [];
      return walk(p);
    }
    return e.name.endsWith('.html') ? [p] : [];
  });
}
const PAGES = walk(DOCS);

const DESK_ANCHOR = /<li><a href="\/storm-alerts" style="color:var\(--orange-light,#f08030\)">Storm Alerts<\/a><\/li>/;
const DESK_INSERT = '<li><a href="/roof-score" style="color:var(--orange-light,#f08030)">Roof Score</a></li>\n        <li><a href="/free-tools" style="color:var(--orange-light,#f08030)">All Free Tools</a></li>\n        ';

const MOB_ANCHOR = /<a href="\/storm-alerts" style="color:#f08030">Storm Alerts<\/a>/;
const MOB_INSERT_BEFORE = '<a href="/roof-score" style="color:#f08030">Roof Score</a>\n  ';

const MOB_STORM_CHECK = /<a href="\/storm-check" style="color:#f08030">Storm Damage Check<\/a>/;
const MOB_INSERT_AFTER = '\n  <a href="/inspect" style="color:#f08030">Free 24-Hr Inspection</a>\n  <a href="/free-tools" style="color:#f08030">All Free Tools</a>';

let deskTouched = 0, mobTouched = 0, bothTouched = 0, alreadyDone = 0;
const uncovered = [];

for (const file of PAGES) {
  const orig = fs.readFileSync(file, 'utf8');
  if (orig.includes('href="/roof-score"')) { alreadyDone++; continue; }

  let next = orig;
  let hitDesk = false, hitMob = false;

  if (DESK_ANCHOR.test(next)) {
    next = next.replace(DESK_ANCHOR, DESK_INSERT + '<li><a href="/storm-alerts" style="color:var(--orange-light,#f08030)">Storm Alerts</a></li>');
    hitDesk = true;
  }
  if (MOB_ANCHOR.test(next)) {
    next = next.replace(MOB_ANCHOR, MOB_INSERT_BEFORE + '<a href="/storm-alerts" style="color:#f08030">Storm Alerts</a>');
    hitMob = true;
  }
  if (MOB_STORM_CHECK.test(next)) {
    next = next.replace(MOB_STORM_CHECK, '<a href="/storm-check" style="color:#f08030">Storm Damage Check</a>' + MOB_INSERT_AFTER);
  }

  if (next !== orig) {
    fs.writeFileSync(file, next, 'utf8');
    if (hitDesk) deskTouched++;
    if (hitMob) mobTouched++;
    if (hitDesk && hitMob) bothTouched++;
  } else {
    uncovered.push(path.relative(DOCS, file).replace(/\\/g, '/'));
  }
}

console.log(JSON.stringify({ deskTouched, mobTouched, bothTouched, alreadyDone, uncoveredCount: uncovered.length, uncovered }, null, 2));
