/**
 * tests/photo-report-output-contract.test.js — what actually reaches the
 * rendered document.
 *
 * THREE BUGS, all of which shipped for months because nothing asserted on
 * OUTPUT — only on the code's shape, where it was asserted at all.
 *
 * 1. THE RUNNING FOOTER NEVER RAN.  design-system.css asked for a per-page
 *    footer with CSS Paged Media: `.doc-band-bottom { position: running(footer) }`
 *    plus `@page { @bottom-center { content: element(footer) } }`. Chromium
 *    implements NEITHER. Measured against the real render path:
 *      CSS.supports('position','running(footer)')  →  false
 *      getComputedStyle('.doc-band-bottom').position →  "static"
 *    so the declaration was dropped, the band fell back to normal flow, and it
 *    rendered ONCE at y=128px — the top of page one, between the letterhead and
 *    the cover title. Every document this renderer has ever produced, all eight
 *    types, shipped that way, with no page numbers at all. Page numbers are only
 *    possible through Chromium's native footerTemplate, so that is what the
 *    renderer uses now, and the band became a closing colophon after <main>.
 *
 * 2. EVERY SERVER-RENDERED REPORT PULLED FULL-RESOLUTION ORIGINALS.  The payload
 *    builder read `p.urls.lg || p.urls.md`. image-pipeline.js names its variants
 *    off VARIANTS[].name — `thumb`, `med`, `full`. Neither `lg` nor `md` has ever
 *    existed, so every photo fell through to `p.url`, the original camera upload,
 *    twenty-odd times inside the renderer's 25s setContent budget.
 *
 * 3. NO REP-TYPED CAPTION HAD EVER APPEARED IN A REPORT.  _captionFor led both
 *    its chains with `p.caption`, a field NOTHING writes — not any of the five
 *    /photos writers, not photo-review.js, not the portal. The field a rep types
 *    into is `description`; the portal's homeowner-facing one is
 *    `homeownerCaption`. Captions always fell through to the AI suggestion or the
 *    bare location string.
 *
 * WHY THESE ASSERTIONS ARE SHAPED THIS WAY.  The two classes are deliberate:
 *
 *   - BEHAVIOURAL, via vm sandbox. buildFooterTemplate and _captionFor are pure,
 *     so they are extracted from source and executed, and the assertions run
 *     against real return values. A regex that merely matches the fixed source
 *     would also match a dozen broken rewrites of it — this repo has shipped a
 *     bug straight past a `/push\(item\)/`-style test before.
 *
 *   - ABSENCE-OF-A-BROKEN-CONSTRUCT. `position: running(` and `@page`
 *     margin-at-rules are inert in this pipeline no matter how they are written,
 *     and `urls.lg` / `urls.md` name variants that do not exist. For those,
 *     "it is not in the file" IS the contract.
 *
 * Zero deps — no functions/node_modules needed (render-pdf.js requires
 * firebase-functions, so it is read and sandboxed, never require()d).
 * Run: node tests/photo-report-output-contract.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const RENDER_PDF = read('functions/render-pdf.js');
const DESIGN_CSS = read('functions/print/design-system.css');
const LAYOUT = read('functions/print/partials/_layout.hbs');
const PHOTO_REPORT = read('docs/pro/js/photo-report.js');
const INSPECTION = read('docs/pro/js/inspection-report-engine.js');

// Strip comments so prose describing a bug can never satisfy — or trip — an
// assertion about the code. Every "must not appear" check below runs on this.
const decomment = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

/** Pull `function <name>(...) { ... }` out of source by brace matching. */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

console.log('PHOTO REPORT — what reaches the rendered document');

// ══ 1. The running footer, executed ═══════════════════════════════════
console.log('\n1. Running footer + page numbers');
{
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    extractFn(RENDER_PDF, 'hbsEsc') + '\n' + extractFn(RENDER_PDF, 'buildFooterTemplate'),
    sandbox
  );
  const build = sandbox.buildFooterTemplate;

  const NBD = { footerName: 'No Big Deal Home Solutions', phone: '(859) 420-7382' };
  const out = build(NBD, { docType: 'Photo Report' }, 'PHO-123456');

  // Chromium substitutes these two classes at paint time. They are the ONLY
  // way to number pages here — the renderer has no Paged Media counters.
  ok('emits a pageNumber placeholder', /class="pageNumber"/.test(out));
  ok('emits a totalPages placeholder', /class="totalPages"/.test(out));

  // The footerTemplate is an isolated document: it inherits no stylesheet and
  // its default font-size is 0, so an unstyled footer renders as nothing at all.
  ok('sets an explicit font-size (0 is the Chromium default and prints blank)',
    /font-size:\s*\d/.test(out));

  ok('carries the tenant name', out.includes('No Big Deal Home Solutions'));
  ok('carries the document number', out.includes('PHO-123456'));

  // Tenant safety — the footer is built from resolved {{company}} chrome, so a
  // stranger tenant must not pick up any NBD literal.
  const STRANGER = { footerName: 'Ridgeline Roofing & "Sons" <LLC>', phone: '(555) 111-2222' };
  const sOut = build(STRANGER, { docType: 'Photo Report' }, 'PHO-1');
  ok('a stranger tenant gets no NBD name', !/No Big Deal/.test(sOut));
  ok('a stranger tenant gets no NBD phone', !/859\)?\s*420-7382/.test(sOut));
  ok('escapes markup in a tenant-controlled name',
    sOut.includes('&amp;') && sOut.includes('&quot;') && sOut.includes('&lt;LLC&gt;'),
    'raw <, > or " would break out of the footer markup');
  ok('a missing phone does not leave a dangling separator',
    !/&middot;\s*<\/span>/.test(build({ footerName: 'Solo Co' }, { docType: 'Invoice' }, '')));

  // The renderer must actually turn the native footer on.
  const code = decomment(RENDER_PDF);
  ok('render-pdf enables displayHeaderFooter', /displayHeaderFooter:\s*true/.test(code));
  ok('render-pdf passes the built footerTemplate',
    /footerTemplate:\s*buildFooterTemplate\(/.test(code));
}

// ══ 2. The inert Paged Media constructs are gone ══════════════════════
console.log('\n2. No CSS the renderer cannot honour');
{
  const css = decomment(DESIGN_CSS);
  ok('no position: running() — Chromium drops it, silently, as invalid',
    !/position:\s*running\(/.test(css));
  ok('no @page margin-at-rules — Chromium implements no margin boxes',
    !/@(top|bottom|left|right)-(left|center|right)\b/.test(css));
  ok('no content: element() — the other half of the same dead mechanism',
    !/content:\s*element\(/.test(css));

  // The band must close the document, not open it.
  const mainEnd = LAYOUT.indexOf('</main>');
  const bandAt = LAYOUT.indexOf('class="doc-band-bottom"');
  ok('the colophon renders after </main>, not above the cover',
    mainEnd !== -1 && bandAt !== -1 && bandAt > mainEnd,
    'band at ' + bandAt + ', </main> at ' + mainEnd);
}

// ══ 3. Print-resolution variants ══════════════════════════════════════
console.log('\n3. Photo variants that exist');
{
  // image-pipeline.js is the authority on variant names — read it, do not
  // hardcode, so renaming a variant there reddens this instead of drifting.
  const PIPE = read('functions/image-pipeline.js');
  const names = [...PIPE.matchAll(/name:\s*'([a-z]+)'\s*,\s*width:/g)].map((m) => m[1]);
  ok('image-pipeline defines exactly thumb/med/full',
    names.join(',') === 'thumb,med,full', 'found: ' + names.join(','));

  for (const [label, src] of [['photo-report.js', PHOTO_REPORT], ['inspection-report-engine.js', INSPECTION]]) {
    const code = decomment(src);
    ok(label + ' reads no urls.lg (variant never existed)', !/urls\.lg\b/.test(code));
    ok(label + ' reads no urls.md (variant never existed)', !/urls\.md\b/.test(code));
    ok(label + ' prefers the 1600px full variant for print', /urls\.full\b/.test(code));
  }
}

// ══ 4. Captions, executed ═════════════════════════════════════════════
console.log('\n4. Rep-typed captions reach the report');
{
  // _captionFor runs every caption through the shared KY claim-wording filter
  // (window.NBDClaimWording, 2026-10-04) — load the real module into the
  // sandbox's window, the way the 'photos' bundle does.
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read('docs/pro/js/claim-wording-filter.js'), sandbox);
  vm.runInContext(extractFn(PHOTO_REPORT, '_captionFor') + '\n' + extractFn(PHOTO_REPORT, '_captionRaw'), sandbox);
  const captionFor = sandbox._captionFor;
  ok('the claim-wording filter loaded into the sandbox window', !!sandbox.window.NBDClaimWording);

  // The field a rep actually types into (customer-tasks-ui.js qeDescription →
  // quickSaveMeta writes photos/{id}.description).
  const typed = { description: 'Cracked boot at the vent stack', location: 'North slope' };
  ok('homeowner mode surfaces a rep-typed description',
    captionFor(typed, 'homeowner') === 'Cracked boot at the vent stack',
    'got: ' + JSON.stringify(captionFor(typed, 'homeowner')));
  ok('adjuster mode surfaces a rep-typed description',
    captionFor(typed, 'adjuster') === 'Cracked boot at the vent stack',
    'got: ' + JSON.stringify(captionFor(typed, 'adjuster')));

  // types.js:216 defines homeownerCaption as the customer-facing override.
  const both = { homeownerCaption: 'Your new vent flashing', description: 'internal note', location: 'Ridge' };
  ok('an explicit homeowner caption outranks the internal note',
    captionFor(both, 'homeowner') === 'Your new vent flashing');

  // Fallbacks still work when nothing is typed.
  const aiOnly = { aiSuggestion: { caption: 'Shingle granule loss' }, location: 'South slope' };
  ok('falls back to the AI caption', captionFor(aiOnly, 'homeowner') === 'Shingle granule loss');
  ok('falls back to location when there is nothing else',
    captionFor({ location: 'West slope' }, 'homeowner') === 'West slope');
  ok('returns empty, not undefined, for a bare photo',
    captionFor({}, 'homeowner') === '' && captionFor({}, 'adjuster') === '');

  // KY claim wording (2026-10-04): an AI caption advising the homeowner on
  // the claim never reaches the report; the observation sentence survives.
  const aiClaim = { aiSuggestion: { caption: 'Hail bruising on three shingles. We recommend filing an insurance claim. Insurance will cover a full replacement.' } };
  for (const mode of ['homeowner', 'adjuster']) {
    const got = captionFor(aiClaim, mode);
    ok(mode + ': the claim advice + payout promise are dropped from an AI caption',
      !/claim|insurance/i.test(got), 'got: ' + JSON.stringify(got));
    ok(mode + ': the observation in the same caption survives', got === 'Hail bruising on three shingles.', 'got: ' + JSON.stringify(got));
  }
  // Filter not loaded → the AI caption is skipped, not printed unchecked.
  const bare = { window: {} };
  vm.createContext(bare);
  vm.runInContext(extractFn(PHOTO_REPORT, '_captionFor') + '\n' + extractFn(PHOTO_REPORT, '_captionRaw'), bare);
  ok('without the filter an AI caption is NOT printed (fail closed)',
    bare._captionFor({ aiSuggestion: { caption: 'File a claim now.' }, location: 'Ridge' }, 'homeowner') === 'Ridge');
}

console.log('\n' + (failed === 0
  ? 'PASS — ' + passed + ' assertions'
  : 'FAIL — ' + failed + ' of ' + (passed + failed) + ': ' + fails.join('; ')));
process.exit(failed === 0 ? 0 : 1);
