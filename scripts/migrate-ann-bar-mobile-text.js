#!/usr/bin/env node
/* One-shot migration: convert hardcoded long-text in .ann-slide divs
   to <span class="ann-text" data-long="LONG" data-short="SHORT">LONG</span>
   and inject <script defer src="/assets/js/ann-bar.js"></script> before
   </body> on any page that has .ann-bar but doesn't already load
   either ann-bar.js or 72f02d79d0.js (index.html's bundled rotator). */

const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs');

// Long → short pairs. Pages have minor whitespace variations after the
// </svg>; we capture and replay it. The "Free Roof Inspections" phone-wrap
// is the bug the user reported; the other slides also get short variants
// for consistency at narrow viewports.
const SLIDE_SWAPS = [
  {
    long:  'NBD Lifetime Pledge — Joe stands behind every install personally',
    short: 'NBD Lifetime Pledge — Backed by Joe'
  },
  {
    long:  'Free Roof Inspections — Call or Text Joe: (859) 420-7382',
    short: 'Free Inspections — (859) 420-7382'
  },
  {
    long:  'Storm Damage? I Document It and Meet Your Adjuster — No Big Deal',
    short: 'Storm Damage? I Meet Your Adjuster'
  },
  {
    long:  'One free roof a year — nominate a Cincinnati neighbor →',
    short: 'One free roof a year →'
  }
];

function escapeAttr(s){
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function walk(dir, out){
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

let convertedSlideCount = 0;
let pagesTouched = 0;
let scriptInjected = 0;
let pagesSkipped = 0;

for (const file of walk(DOCS)) {
  let src = fs.readFileSync(file, 'utf8');
  if (!/class="ann-bar"/.test(src)) continue;

  let pageChanged = false;

  for (const { long, short } of SLIDE_SWAPS) {
    // Match the text content inside .ann-slide and rewrap. Allow the text
    // to be preceded by a closing </svg> + whitespace, OR by the opening
    // </a> trail in the free-roof slide variant. Conservative: only swap
    // when the EXACT long text appears literally (no partial-string risk).
    // Use a tolerant variant for the → arrow which appears as both U+2192
    // and the HTML entity &rarr; in source.
    const candidates = long.includes('→')
      ? [long, long.replace('→', '&rarr;')]
      : [long];

    for (const literal of candidates) {
      // Already wrapped in .ann-text — skip.
      const wrappedCheck = new RegExp(
        'data-long="' + literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                              .replace(/"/g, '\\"') + '"');
      if (wrappedCheck.test(src)) continue;

      const idx = src.indexOf(literal);
      if (idx === -1) continue;

      const replacement = '<span class="ann-text" data-long="' +
        escapeAttr(literal) + '" data-short="' +
        escapeAttr(short) + '">' + literal + '</span>';

      src = src.slice(0, idx) + replacement + src.slice(idx + literal.length);
      convertedSlideCount++;
      pageChanged = true;
    }
  }

  // Inject the script tag if missing. Skip pages that already load
  // either ann-bar.js or the bundled rotator 72f02d79d0.js (index.html).
  const hasAnnBar    = /\/assets\/js\/ann-bar\.js/.test(src);
  const hasBundled   = /72f02d79d0\.js/.test(src);
  if (!hasAnnBar && !hasBundled) {
    const tag = '<script defer src="/assets/js/ann-bar.js"></script>';
    const closeBody = src.lastIndexOf('</body>');
    if (closeBody !== -1) {
      src = src.slice(0, closeBody) + tag + '\n' + src.slice(closeBody);
      scriptInjected++;
      pageChanged = true;
    }
  }

  if (pageChanged) {
    fs.writeFileSync(file, src);
    pagesTouched++;
  } else {
    pagesSkipped++;
  }
}

console.log('Migration complete.');
console.log('Pages touched:        ', pagesTouched);
console.log('Slides converted:     ', convertedSlideCount);
console.log('Script tags injected: ', scriptInjected);
console.log('Ann-bar pages skipped:', pagesSkipped, '(already migrated)');
