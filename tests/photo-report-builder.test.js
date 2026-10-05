/**
 * tests/photo-report-builder.test.js — the D-6 report builder.
 *
 * D-4 shipped the photo report as a fixed document: one cover, three stat
 * cards, three phase galleries in a fixed order, every heading and every line
 * of cover prose a hardcoded literal. The rep's only choice was homeowner vs
 * adjuster. D-6 makes the document a function of `opts` + `sections`, which
 * means there is now an option contract that can drift from what the template
 * actually honours — so this asserts BOTH halves against real behaviour:
 *
 *   1. The client option contract, vm-sandboxed out of photo-report.js and
 *      executed. Enum coercion matters more than it looks: an unrecognised
 *      density reaches the <body> as an unmatched class and silently styles
 *      nothing, and an unrecognised numbering silently drops every photo
 *      number. Both fail open and look fine in review.
 *
 *   2. The real Handlebars template, compiled with the real helpers out of
 *      render-pdf.js and rendered. Asserting the OUTPUT is the point — a test
 *      that grepped photoReport.hbs for `{{#if opts.showToc}}` would pass
 *      against a template that renders the contents block unconditionally.
 *
 * Handlebars is required, not optional: .github/workflows/ci.yml installs
 * functions deps before the manifest runner precisely so a test may require()
 * out of functions/. If it cannot load, this file FAILS rather than skipping —
 * a suite that quietly renders zero assertions is how a gate goes green
 * without testing anything.
 *
 * Run: node tests/photo-report-builder.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PHOTO_REPORT = read('docs/pro/js/photo-report.js');

// Strip comments so prose describing a bug cannot satisfy — or trip — an
// assertion about the code.
const decommentJs = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function endOfFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced braces reading ' + name);
}

console.log('PHOTO REPORT BUILDER — options, numbering, and what the template does with them');

// ══ 1. The option contract, executed ══════════════════════════════
console.log('\n1. Option contract');
const sandbox = {};
{
  // One contiguous slice: the defaults, the enum lists, and the three pure
  // functions that read them.
  const from = PHOTO_REPORT.indexOf('const REPORT_DEFAULTS');
  const to = endOfFn(PHOTO_REPORT, '_numberSections');
  vm.createContext(sandbox);
  // _dateLabel sits inside that slice but its timestamp resolution does not —
  // it shares _photoTimestampMs with _comparePhotoReportOrder, ~1000 lines up,
  // so that the caption and the sort key can never read different fields.
  // Lift it first or every _dateLabel assertion below dies on a ReferenceError.
  const tsFrom = PHOTO_REPORT.indexOf('function _photoTimestampMs(');
  vm.runInContext(PHOTO_REPORT.slice(tsFrom, endOfFn(PHOTO_REPORT, '_photoTimestampMs')), sandbox);
  vm.runInContext(PHOTO_REPORT.slice(from, to), sandbox);
}
const optionsFor = sandbox._reportOptions;
const numberSections = sandbox._numberSections;
const dateLabel = sandbox._dateLabel;

{
  const h = optionsFor('homeowner');
  const a = optionsFor('adjuster');

  // The two modes are different documents. If these ever converge, someone has
  // flattened a deliberate distinction.
  ok('homeowner defaults to the story look', h.density === 'comfortable' && h.showPairs === true);
  ok('adjuster defaults to the evidence look', a.density === 'evidence' && a.columns === 3);
  ok('adjuster numbers and dates every frame', a.numbering === 'continuous' && a.showDate === true);
  ok('homeowner does NOT date every frame', h.showDate === false);
  ok('homeowner report carries no signature line by default', h.signature === 'none');
  ok('adjuster report is signed', a.signature === 'adjuster');
  ok('an unknown mode falls back to homeowner',
    optionsFor('nonsense').density === h.density);

  // Enum coercion — the failure mode is silent, so this is the load-bearing part.
  ok('an unknown density falls back rather than reaching the body class',
    optionsFor('homeowner', { density: 'sparkly' }).density === 'comfortable');
  ok('an unknown numbering falls back rather than dropping every number',
    optionsFor('homeowner', { numbering: 'roman' }).numbering === 'continuous');
  ok('an unknown cover style falls back', optionsFor('homeowner', { cover: 'splash' }).cover === 'hero');
  ok('an unknown signature value falls back',
    optionsFor('adjuster', { signature: 'notary' }).signature === 'adjuster');
  ok('columns is clamped to 1..4, 0 meaning auto',
    optionsFor('homeowner', { columns: 9 }).columns === 0
    && optionsFor('homeowner', { columns: 3 }).columns === 3
    && optionsFor('homeowner', { columns: -2 }).columns === 0);
  ok('fit is cover unless explicitly contain',
    optionsFor('homeowner', { fit: 'squish' }).fit === 'cover'
    && optionsFor('homeowner', { fit: 'contain' }).fit === 'contain');

  // A default of `false` must survive the boolean normalisation pass.
  ok('an unset boolean keeps its mode default, not true',
    optionsFor('homeowner').showToc === false && optionsFor('adjuster').showToc === true);
  ok('an explicit false is honoured', optionsFor('adjuster', { showDate: false }).showDate === false);
  ok('an explicit true is honoured', optionsFor('homeowner', { showToc: true }).showToc === true);
  ok('overrides do not mutate the shared defaults',
    optionsFor('homeowner', { columns: 4 }).columns === 4 && optionsFor('homeowner').columns === 0);
}

// ══ 2. Numbering ══════════════════════════════════════════════════
console.log('\n2. Photo numbering');
{
  const mk = () => ([
    { id: 'before', photos: [{}, {}, {}] },
    { id: 'during', photos: [{}, {}] },
    { id: 'after', photos: [{}] },
  ]);

  const cont = numberSections(mk(), 'continuous');
  ok('continuous runs 1..N across the whole document',
    cont.flatMap((s) => s.photos.map((p) => p.n)).join(',') === '1,2,3,4,5,6');

  // The client fallback numbered per section, restarting at #01 three times,
  // which makes "see photo 3" ambiguous in an adjuster's narrative. Per-section
  // is still offered, but it must be the explicit choice.
  const per = numberSections(mk(), 'section');
  ok('per-section restarts at 1 in each section',
    per.flatMap((s) => s.photos.map((p) => p.n)).join(',') === '1,2,3,1,2,1');

  const none = numberSections(mk(), 'none');
  ok('none leaves no n at all — not 0, which the template would print',
    none.every((s) => s.photos.every((p) => !('n' in p))));

  ok('an empty section list does not throw', numberSections([], 'continuous').length === 0);
  ok('a section with no photos is skipped without disturbing the run',
    numberSections([{ photos: [] }, { photos: [{}, {}] }], 'continuous')[1].photos.map((p) => p.n).join(',') === '1,2');
}

// ══ 3. Capture dates ══════════════════════════════════════════════
console.log('\n3. Capture date fallback chain');
{
  // Five independent writers stamp /photos and none agree on the field or the
  // shape, so this chain is the only thing standing between a dated exhibit
  // and a blank.
  ok('reads a Firestore Timestamp (toMillis)',
    dateLabel({ createdAt: { toMillis: () => Date.UTC(2026, 7, 14, 15) } }).includes('2026'));
  ok('reads a {seconds} timestamp',
    dateLabel({ createdAt: { seconds: Math.floor(Date.UTC(2026, 7, 14, 15) / 1000) } }).includes('2026'));
  ok('reads an ISO string', dateLabel({ date: '2026-08-14T15:00:00Z' }).includes('2026'));
  ok('reads epoch millis', dateLabel({ uploadedAt: Date.UTC(2026, 7, 14, 15) }).includes('2026'));
  ok('reads a Date', dateLabel({ capturedAt: new Date(Date.UTC(2026, 7, 14, 15)) }).includes('2026'));
  ok('EXIF takenAt outranks the upload time',
    dateLabel({ exif: { takenAt: '2026-08-14T15:00:00Z' }, uploadedAt: '2026-09-02T15:00:00Z' }).includes('Aug'));
  ok('an unparseable value yields empty, not "Invalid Date"',
    dateLabel({ createdAt: 'not a date' }) === '');
  ok('a photo with no timestamp at all yields empty', dateLabel({}) === '');
}

// ══ 4. The template, rendered ═════════════════════════════════════
console.log('\n4. Template output');
{
  const Handlebars = require(path.join(ROOT, 'functions/node_modules/handlebars'));
  const R = require(path.join(ROOT, 'functions/render-pdf.js'));
  R._registerPartialsOnce();
  R._registerHelpersOnce();
  const tpl = Handlebars.compile(read('functions/print/templates/photoReport.hbs'));

  const photos = (n, from) => Array.from({ length: n }, (_, i) => ({
    url: 'x.png', caption: 'cap ' + (i + 1), location: 'North slope',
    damageType: 'Hail', severity: 'Poor', dateLabel: 'Aug 14, 2026', n: (from || 1) + i,
  }));
  const base = (opts, extra) => Object.assign({
    opts, mode: 'homeowner',
    company: { footerName: 'NBD Co', seal: 'NBD' },
    preparedFor: { name: 'A Homeowner' }, preparedBy: { name: 'Joe Deal' },
    summary: { headline: 'Head', body: 'Body' },
    sections: [{ id: 'before', title: 'Before', blurb: 'b', note: '', photos: photos(3) }],
    toc: [{ title: 'Before', count: 3 }],
    notes: { coverLetter: '', summaryBody: '', closing: '' },
    meta: [], pairs: [], stats: [],
  }, extra || {});
  const O = (o) => Object.assign({
    cover: 'hero', density: 'comfortable', columns: 0, fit: 'cover',
    numbering: 'continuous', numberLabel: '', showToc: false, showStats: true,
    showPairs: true, showDate: false, showLocation: true, showDamage: false,
    showSeverity: false, signature: 'none',
  }, o || {});

  const numbered = tpl(base(O({ numberLabel: 'Photo' })));
  ok('numbers render on the tiles', (numbered.match(/pr-num/g) || []).length === 3);
  ok('the number label prefixes the digit', /Photo\s*1/.test(numbered));

  ok('numbering:none renders no number chips',
    !/pr-num/.test(tpl(base(O({ numbering: 'none' })))));

  ok('showToc:false renders no contents block', !/pr-toc-row/.test(tpl(base(O()))));
  ok('showToc:true renders one row per section',
    (tpl(base(O({ showToc: true }))).match(/pr-toc-row/g) || []).length === 1);

  ok('showDate:false hides capture dates', !/pr-date/.test(tpl(base(O()))));
  ok('showDate:true prints them', /Aug 14, 2026/.test(tpl(base(O({ showDate: true })))));
  ok('showSeverity:false hides the badge', !/class="sev /.test(tpl(base(O()))));
  ok('showLocation:false hides the tag', !/photo-tag/.test(tpl(base(O({ showLocation: false })))));

  ok('cover:none omits the cover page',
    !/cover-v2/.test(tpl(base(O({ cover: 'none' })))));
  ok('cover:hero renders it', /cover-v2/.test(tpl(base(O()))));

  // Sections are ordered and arbitrary — the whole point of D-6.
  const reordered = tpl(base(O(), {
    sections: [
      { id: 'after', title: 'After', blurb: '', note: '', photos: photos(1) },
      { id: 'before', title: 'Before', blurb: '', note: '', photos: photos(1) },
    ],
  }));
  ok('sections render in the order given, not a fixed phase order',
    reordered.indexOf('>After<') < reordered.indexOf('>Before<'));

  // Rep-authored prose.
  const noted = tpl(base(O(), {
    notes: { coverLetter: 'Line one\n\nLine two', summaryBody: '', closing: 'Bye' },
    sections: [{ id: 'before', title: 'Before', blurb: 'b', note: 'Section note here', photos: photos(1) }],
  }));
  ok('a cover letter renders', /pr-letter/.test(noted) && /Line one/.test(noted));
  ok('a blank line becomes a paragraph break, not a lost line',
    /Line one<\/p><p>Line two/.test(noted));
  ok('a section note renders', /pr-note/.test(noted) && /Section note here/.test(noted));
  ok('a closing note renders', /Bye/.test(noted));

  // nl2br uses a triple-stache, so it owns its own escaping. Rep prose is user
  // input landing in a customer-facing PDF.
  const nasty = tpl(base(O(), {
    notes: { coverLetter: '<img src=x onerror=alert(1)>', summaryBody: '', closing: '' },
  }));
  ok('rep prose is escaped, not injected',
    !/<img src=x/.test(nasty) && /&lt;img src=x/.test(nasty));

  // Signature blocks.
  ok('signature:none renders no signature block', !/sig-line/.test(tpl(base(O()))));
  ok('signature:homeowner names the homeowner',
    /A Homeowner/.test(tpl(base(O({ signature: 'homeowner' })))));
  ok('signature:adjuster renders the attestation and adjuster line',
    /Adjuster Acknowledgment/.test(tpl(base(O({ signature: 'adjuster' })))));
  ok('signature:both renders two blocks',
    (tpl(base(O({ signature: 'both' }))).match(/sig-block/g) || []).length === 2);

  // The D-4 attestation claimed every image was unmodified. photo-editor.js
  // bakes markup into the saved file, so that was a false statement in a
  // document a carrier may rely on.
  const att = tpl(base(O({ signature: 'adjuster' }), { hasAnnotated: true }));
  ok('the attestation no longer claims images are unmodified',
    !/unmodified except/i.test(att));
  ok('the attestation declares annotated frames when there are any',
    /Annotated/.test(att));
  ok('and stays silent about annotation when there are none',
    !/Annotated/.test(tpl(base(O({ signature: 'adjuster' }), { hasAnnotated: false }))));

  // Grid columns come from the helper, not from the template counting.
  ok('columns:1 asks for the one-up grid', / one"/.test(tpl(base(O({ columns: 1 })))));
  ok('columns:4 asks for the four-up grid', / four"/.test(tpl(base(O({ columns: 4 })))));
  ok('columns:0 falls back to D-4 behaviour — three-up past six photos',
    / three"/.test(tpl(base(O({ columns: 0 }), {
      sections: [{ id: 'b', title: 'B', blurb: '', note: '', photos: photos(7) }],
    }))));
  ok('columns:0 with a short section stays two-up',
    !/photo-grid three/.test(tpl(base(O({ columns: 0 })))));

  // Density is a body class assembled by the renderer, and it is a closed set.
  ok('a known density passes through', R._normalizeDensity('evidence') === 'evidence');
  ok('an unknown density normalises to comfortable',
    R._normalizeDensity('sparkly') === 'comfortable' && R._normalizeDensity(undefined) === 'comfortable');
  ok('the per-template stylesheet is actually found',
    R._loadTemplateCss('photoReport').includes('.pr-num'));
  ok('a template with no stylesheet returns empty, not a throw',
    R._loadTemplateCss('warranty') === '');
}

// ══ 5. The builder UI and the contract it targets ═════════════════
console.log('\n5. Builder UI ↔ option contract');
{
  const PICKER = read('docs/pro/js/customer-photo-report-picker.js');

  // THE drift risk. The old picker's card copy promised "numbered photos for
  // supplements" while the server template emitted no numbers at all — a
  // control surface and a renderer written apart, with nothing tying them
  // together. Every key the builder offers must be a key the report honours.
  const offered = [...PICKER.matchAll(/\{ key: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  const noteKeys = ['coverLetter', 'summaryBody', 'closing'];
  const known = Object.keys(optionsFor('homeowner'));
  const unknown = offered.filter((k) => known.indexOf(k) < 0 && noteKeys.indexOf(k) < 0);
  ok('every control the builder offers maps to a real option',
    unknown.length === 0, 'orphaned: ' + unknown.join(', '));
  ok('the builder offers a meaningful share of the contract',
    offered.filter((k) => known.indexOf(k) >= 0).length >= 12,
    'only ' + offered.filter((k) => known.indexOf(k) >= 0).length + ' mapped');

  // Segmented values must be values the contract accepts, or a rep clicks a
  // button and silently gets the default back.
  // Each control is one line, so read the line rather than trying to balance
  // the nested [value, label] pairs with a regex.
  const lineFor = (key) => (PICKER.split('\n').find((l) => l.indexOf("key: '" + key + "'") >= 0) || '');
  ok('the style control offers exactly the three real densities',
    ['comfortable', 'compact', 'evidence'].every((d) => lineFor('density').indexOf("'" + d + "'") >= 0),
    lineFor('density').trim().slice(0, 90));
  ok('the numbering control offers exactly the three real modes',
    ['continuous', 'section', 'none'].every((n) => lineFor('numbering').indexOf("'" + n + "'") >= 0),
    lineFor('numbering').trim().slice(0, 90));
  ok('the cover control offers exactly the three real styles',
    ['hero', 'minimal', 'none'].every((c) => lineFor('cover').indexOf("'" + c + "'") >= 0));
  ok('the signature control offers exactly the four real values',
    ['none', 'homeowner', 'adjuster', 'both'].every((s) => lineFor('signature').indexOf("'" + s + "'") >= 0));

  // CSP: /pro ships script-src-attr 'none'. An on* attribute here is silently
  // dead — no error, just a control that does nothing.
  ok('the builder ships no inline event handlers',
    !/\son[a-z]+\s*=/.test(PICKER.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')));
  ok('it wires everything with addEventListener', /addEventListener\(/.test(PICKER));

  // generatePhotoReport must accept the third argument the builder sends.
  ok('generatePhotoReport takes the build object',
    /function generatePhotoReport\(leadId, mode, build\)/.test(PHOTO_REPORT));
  ok('the builder passes it through', /generatePhotoReport\(window\._customerId, mode, build\)/.test(PICKER));

  // The builder reads the option contract at runtime through
  // __NBD_CALL_REGISTRY._photoReportOptions (off window since Globals Tranche 3,
  // T3-C). Execute the WHOLE file the way the lazy 'photos' bundle does, into a
  // window whose registry customer.html's own module already populated: the
  // entry must land, must be the real contract, and must not replace the
  // registry — a bare `= Object.create(null)` here would silently drop every
  // customer-page entry the moment a rep opened the builder.
  {
    const pageEntry = function () {};
    const win = { __NBD_CALL_REGISTRY: { _fetchPhotosRaw: pageEntry } };
    const reg0 = win.__NBD_CALL_REGISTRY;
    const box = { window: win, console: console };
    vm.createContext(box);
    vm.runInContext(PHOTO_REPORT, box, { filename: 'photo-report.js' });
    const fn = win.__NBD_CALL_REGISTRY._photoReportOptions;
    ok('photo-report.js registers _photoReportOptions on the call registry', typeof fn === 'function');
    ok('and leaves the page\'s existing registry (and its entries) in place',
      win.__NBD_CALL_REGISTRY === reg0 && win.__NBD_CALL_REGISTRY._fetchPhotosRaw === pageEntry);
    // Executed, not grepped: catches a bracketed or globalThis spelling too.
    ok('_photoReportOptions is no longer a window global',
      !('_photoReportOptions' in win) && !('_photoReportOptions' in box));
    ok('the registered function IS the option contract the builder mirrors',
      typeof fn === 'function'
      && JSON.stringify(fn('adjuster')) === JSON.stringify(optionsFor('adjuster'))
      && JSON.stringify(fn('homeowner')) === JSON.stringify(optionsFor('homeowner')));
  }

  // The consumer half, executed: run the WHOLE picker against a stub page and
  // read back what it seeded. Every window below also carries a DECOY
  // `_photoReportOptions` that returns something the real contract never does,
  // so a resolver reading window (`var reg = window;`, `reg || window`, a
  // bracketed or globalThis spelling) seeds the decoy and goes RED, and a
  // resolver reading the wrong registry name seeds `{}` and goes RED — neither
  // needs the source text to match a pin. The picker's _prpSetPreset /
  // _prpCollect test hooks are how we read the builder's state.
  {
    const decoy = () => ({ decoy: 'read off window' });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const runPicker = (win) => {
      const box = {
        window: win,
        document: { readyState: 'complete', getElementById: () => null, addEventListener: () => {} },
        setTimeout: () => {},
        console: console,
      };
      vm.createContext(box);
      vm.runInContext(PICKER, box, { filename: 'customer-photo-report-picker.js' });
      return win;
    };

    // 1. Bundle already landed: the preset seeds from the registry entry.
    const loaded = runPicker({
      __NBD_CALL_REGISTRY: { _photoReportOptions: optionsFor },
      _photoReportOptions: decoy,
    });
    loaded._prpSetPreset('adjuster');
    const seeded = loaded._prpCollect() && loaded._prpCollect().options;
    ok('the builder seeds a preset from __NBD_CALL_REGISTRY._photoReportOptions, not window',
      same(seeded, optionsFor('adjuster')), JSON.stringify(seeded));

    // 2. Bundle not landed (no registry entry): not-loaded, never window's copy.
    const cold = runPicker({ __NBD_CALL_REGISTRY: {}, _photoReportOptions: decoy });
    cold._prpSetPreset('adjuster');
    const coldOpts = cold._prpCollect() && cold._prpCollect().options;
    ok('with no registry entry the builder seeds {} (not loaded), never a window copy',
      same(coldOpts, {}), JSON.stringify(coldOpts));

    // 3. Opened before the lazy bundle lands: warm 'photos', and once it has
    // registered the entry, re-seed the open preset from it. The thenable runs
    // its callback synchronously so this stays a plain sequential assertion.
    const warmed = [];
    const lazy = {
      _customerId: 'lead-1',
      nbdModal: { open: () => {} },
      _photoReportOptions: decoy,
      ScriptLoader: {
        loadBundle: (name) => {
          warmed.push(name);
          return {
            then: (cb) => {
              lazy.__NBD_CALL_REGISTRY = { _photoReportOptions: optionsFor };
              cb();
              return { catch: () => {} };
            },
          };
        },
      },
    };
    runPicker(lazy);
    lazy.openPhotoReportPicker();
    const reseeded = lazy._prpCollect() && lazy._prpCollect().options;
    ok('opening before the bundle lands warms \'photos\' and re-seeds from the registry entry',
      warmed.join(',') === 'photos' && same(reseeded, optionsFor('homeowner')),
      'warmed=' + warmed.join(',') + ' options=' + JSON.stringify(reseeded));

    // 4. Opened after it landed: no second bundle load.
    const warm2 = [];
    const ready = runPicker({
      _customerId: 'lead-1',
      nbdModal: { open: () => {} },
      __NBD_CALL_REGISTRY: { _photoReportOptions: optionsFor },
      _photoReportOptions: decoy,
      ScriptLoader: { loadBundle: (name) => { warm2.push(name); return { then: () => ({ catch: () => {} }) }; } },
    });
    ready.openPhotoReportPicker();
    ok('opening after the bundle landed seeds from the registry and loads nothing',
      warm2.length === 0 && same(ready._prpCollect().options, optionsFor('homeowner')),
      'warmed=' + warm2.join(','));
  }

  // The markup the builder drives has to exist on the page it lives on.
  const CUSTOMER = read('docs/pro/customer.html');
  ['prpBuilder', 'prpGenerate', 'prpToggle', 'prpCancel'].forEach((id) => {
    ok('customer.html carries #' + id, CUSTOMER.indexOf('id="' + id + '"') >= 0);
  });
  ok('both presets are present',
    /data-prp-preset="homeowner"/.test(CUSTOMER) && /data-prp-preset="adjuster"/.test(CUSTOMER));
  // The old two-button markup dispatched through the global data-action
  // delegate; the builder binds its own listeners, so a leftover data-action
  // would fire generate twice.
  ok('the preset cards no longer double-dispatch through data-action',
    !/data-action="pickPhotoReport"/.test(CUSTOMER));
}

// ══ 6. Who can see the photos, and who can reach the builder ══════
console.log('\n6. Reach');
{
  const code = decommentJs(PHOTO_REPORT);

  // A company reader viewing a teammate's lead: the gallery drops the userId
  // filter via _photoQueryScopes, the report did not, so the manager saw a
  // full grid behind a modal that said there were no photos at all.
  ok('the report scopes photos through the shared helper',
    /window\._photoQueryScopes\(leadId\)/.test(code));
  ok('and keeps the owner-scoped pair as the fallback',
    /where\('leadId', '==', leadId\)[\s\S]{0,120}where\('userId'/.test(code));
  const BOOT = read('docs/pro/js/customer-bootstrap.module.js');
  ok('the helper is actually exported for non-module scripts',
    /window\._photoQueryScopes\s*=\s*_photoQueryScopes/.test(BOOT));

  // A rules denial or an offline client used to be reported as "no photos
  // found — upload some first", which sends a rep to go take photos that
  // already exist.
  ok('a failed photo query is not reported as an empty lead',
    /Could not load photos/.test(PHOTO_REPORT));

  // The dashboard chip called generatePhotoReport(leadId) with no mode, so it
  // silently produced a homeowner report and no dashboard user could reach
  // adjuster mode or any builder option.
  const DASH = decommentJs(read('docs/pro/js/dashboard-bootstrap.module.js'));
  const chip = DASH.slice(DASH.indexOf("actionId === 'photo_report'"), DASH.indexOf("actionId === 'photo_report'") + 700);
  ok('the dashboard chip routes to the builder rather than firing a report',
    /#photo-report/.test(chip) && !/window\.generatePhotoReport\(leadId\)/.test(chip));
  ok('and builds the URL through NBDUrl, absolute per the inter-page nav rule',
    /NBDUrl && window\.NBDUrl\.customer\(leadId\)/.test(chip) && /'\/pro\/customer\.html\?id='/.test(chip));
  // tests/smoke/dashboard.test.js:2867 fails any relative bare-.html nav on
  // /pro; a quoted literal after location.href is exactly what it looks for.
  ok('the new nav introduces no relative bare-.html target',
    !/location(?:\.href)?\s*=\s*["'][a-z0-9_-]+\.html/.test(chip));
}

// ══ 7. The report is recorded ═════════════════════════════════════
console.log('\n7. Filed on the lead');
{
  const code = decommentJs(PHOTO_REPORT);

  // This module contained ZERO Firestore writes. A photo report existed only
  // as a browser tab and a file in the rep's Downloads folder — no history, no
  // re-download, nothing for a share link to point at — while every other
  // document producer in the CRM files a row.
  ok('a rendered report is written to leads/{id}/documents',
    /collection\(window\.db, 'leads', leadId, 'documents'\)/.test(code));
  ok('it is tagged so the Documents tab can tell it apart',
    /source: 'photo_report'/.test(code));
  ok('it records the options the rep chose, so it can be regenerated',
    /reportOptions: rec\.options/.test(code));

  // render-pdf.js returns a 7-day signed URL where IAM signBlob is reachable
  // and a download-token URL where it is not, so the recorded link can go dead.
  // The storage path does not.
  ok('it records storagePath alongside the (possibly expiring) url',
    /storagePath: rec\.storagePath/.test(code) && /url: rec\.url/.test(code));

  // A finished PDF must never be reported as a failure because the row could
  // not be written — a sales_rep or viewer on a teammate's lead is a legitimate
  // denial.
  // Read the decommented source: the explanatory comment between the catch and
  // the warn is long, and a distance-bounded match against the raw file would
  // be measuring comment length rather than code structure.
  ok('filing cannot fail the render',
    /catch \(e\) \{[\s\S]{0,200}could not file the report on the lead/.test(code));
  ok('and it is fired without being awaited by the render path',
    // Held in _filing so the AUTOMATIC Before & After report (2026-10-04,
    // opts.auto) can await it; the interactive path never does.
    /^\s*(const _filing = )?_fileReportOnLead\(lead\.id,/m.test(code) && !/^\s*await _fileReportOnLead\(/m.test(code));

  const RULES = read('firestore.rules');
  // The rule filing depends on. This assertion originally pinned the
  // owner-only clause as a fixed dependency; the next commit widened it, and
  // the assertion reddened — which is the check working. It now pins the shape
  // filing actually needs: the owner OR same-company staff, never a viewer.
  // 2026-09-25: filing is a CREATE; the rule split `allow write` into
  // `allow create, update` + a separate `allow delete` (the status validator
  // read request.resource, null on a delete, so no client could delete a row).
  const docRule = RULES.slice(RULES.indexOf('match /documents/{documentId}'),
    RULES.indexOf('match /drawings/{drawingId}'));
  ok('the documents write rule admits the owner and same-company staff',
    /allow create, update: if isAuth\(\)/.test(docRule)
    && /isOwner\(get\(/.test(docRule)
    && /isCompanyStaff\(\) && parentLeadInMyCompany\(leadId\)/.test(docRule));
  ok('and it does not reach for isCompanyReader, which would hand viewers write',
    !/isCompanyReader\(\)/.test(docRule));

  ok('the documents list is refreshed so the row appears without a reload',
    /NBDCustomerDocs\.refresh\(\)/.test(code));
}

console.log('\n' + (failed === 0
  ? 'PASS — ' + passed + ' assertions'
  : 'FAIL — ' + failed + ' of ' + (passed + failed) + ': ' + fails.join('; ')));
process.exit(failed === 0 ? 0 : 1);
