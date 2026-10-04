/**
 * tests/photo-editor-annotation-persistence.test.js
 *
 * docs/pro/js/photo-editor.js keeps drawn annotations (arrows/callouts/
 * stamps/measurements/pen strokes) ONLY in a bare in-memory module-closure
 * array (`let annotations = [];`), which is unconditionally reset to `[]`
 * on every open/switch/close. No save path ever wrote it to Firestore:
 * `saveTagsOnly()` (the lightweight "Save Tags" button) wrote a `meta`
 * object with damageType/severity/location/phase/notes/tags/brightness/
 * contrast but never `annotations`, and the only path that visually
 * preserved markup was flatten-and-save -> uploadBlob(), which rasterizes
 * everything onto a NEW image and discards the vector shape data — so
 * re-opening even an already-annotated photo could never show editable
 * shapes again, only flattened pixels.
 *
 * This suite RUNS the real photo-editor.js in a hand-built fake-DOM vm
 * sandbox (model: tests/inspection-report-photos.test.js's vm harness +
 * tests/qab-comm-log.test.js's addEventListener-recording fake elements),
 * drives an actual mousedown -> mousemove -> mouseup sequence through the
 * real pointer-event code path to produce one real annotation, clicks the
 * real "Save Tags" button handler, and inspects what actually got handed
 * to `updateDoc` — not a regex over the source text for the main flow.
 * A second static-text check (model: tests/photo-report-output-contract.
 * test.js) pins the `meta` object literals as a cheap, fast regression
 * guard independent of the full DOM harness.
 *
 * Run: node tests/photo-editor-annotation-persistence.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const EDITOR_SRC = read('docs/pro/js/photo-editor.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
function group(name) { console.log('\n' + name); }

/* ============================================================
   FAST STATIC-TEXT GUARD — independent of the DOM harness
   ============================================================ */
function extractFunctionBody(source, fnName) {
  const idx = source.indexOf('function ' + fnName + '(');
  if (idx === -1) return '';
  const braceStart = source.indexOf('{', idx);
  if (braceStart === -1) return '';
  let depth = 0, end = braceStart;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  return source.slice(idx, end);
}

group('STATIC — meta object literals reference annotations (cheap regression guard)');
{
  const saveTagsBody = extractFunctionBody(EDITOR_SRC, 'saveTagsOnly');
  ok('saveTagsOnly() exists in the source', !!saveTagsBody);
  // 2026-10-04: both saves build their meta in _metaNow() (they queue through
  // PhotoEngine.enqueueEdit); the literal lives there.
  const metaNowBody = extractFunctionBody(EDITOR_SRC, '_metaNow');
  const saveTagsMeta = /const meta = \{([\s\S]*?)\};/.exec(saveTagsBody)
    || (/_metaNow\(/.test(saveTagsBody) ? /return \{([\s\S]*?)\};/.exec(metaNowBody) : null);
  ok('saveTagsOnly() has a meta object literal', !!saveTagsMeta);
  ok('saveTagsOnly()\'s meta object literal writes annotations',
    !!saveTagsMeta && /annotations\s*:/.test(saveTagsMeta[1]),
    saveTagsMeta ? saveTagsMeta[1].trim() : '(no meta literal found)');

  const uploadBlobBody = extractFunctionBody(EDITOR_SRC, 'uploadBlob');
  ok('uploadBlob() exists in the source', !!uploadBlobBody);
  const uploadBlobMeta = /const meta = \{([\s\S]*?)\};/.exec(uploadBlobBody)
    || (/_metaNow\(/.test(uploadBlobBody) ? /return \{([\s\S]*?)\};/.exec(metaNowBody) : null);
  ok('uploadBlob() has a meta object literal', !!uploadBlobMeta);
  ok('uploadBlob()\'s (shared, both-branches) meta object literal writes annotations',
    !!uploadBlobMeta && /annotations\s*:/.test(uploadBlobMeta[1]),
    uploadBlobMeta ? uploadBlobMeta[1].trim() : '(no meta literal found)');

  // The originalUrl/originalStoragePath backup must be idempotent (guarded)
  // and live in the save-over branch specifically.
  ok('uploadBlob() guards the originalUrl/originalStoragePath backup on hasOriginalBackup',
    /hasOriginalBackup/.test(uploadBlobBody) && /originalUrl/.test(uploadBlobBody) && /originalStoragePath/.test(uploadBlobBody));
}

group('STATIC — read side seeds annotations instead of always resetting to []');
{
  const openEditorBody = extractFunctionBody(EDITOR_SRC, 'openEditor');
  ok('openEditor() exists in the source', !!openEditorBody);
  ok('openEditor()\'s photoData branch seeds annotations from photoData.annotations',
    /photoData\.annotations/.test(openEditorBody));
  ok('openEditor()\'s getDoc fallback branch seeds annotations from the fetched doc',
    /\bd\.annotations\b/.test(openEditorBody));

  const switchPhotoBody = extractFunctionBody(EDITOR_SRC, 'switchPhoto');
  ok('switchPhoto() exists in the source', !!switchPhotoBody);
  ok('switchPhoto() seeds annotations from the target photo\'s own annotations field',
    /photo\s*&&\s*Array\.isArray\(photo\.annotations\)/.test(switchPhotoBody) || /photo\.annotations/.test(switchPhotoBody));
  ok('switchPhoto() no longer unconditionally resets annotations to []',
    !/annotations = \[\];/.test(switchPhotoBody));
}

/* ============================================================
   FAKE DOM — hand-built, addEventListener records for later
   manual invocation, vm.runInContext loads the real source.
   ============================================================ */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function makeCtx() {
  return {
    strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, drawImage() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    rect() {}, arc() {}, arcTo() {}, ellipse() {}, roundRect() {}, setLineDash() {},
    measureText() { return { width: 0 }; },
    getImageData() { return { data: [] }; }, putImageData() {},
    translate() {}, scale() {}, fillText() {}, strokeText() {},
  };
}

function makeClassList(el) {
  return {
    _s: new Set(),
    add(...cs) { cs.forEach((c) => this._s.add(c)); },
    remove(...cs) { cs.forEach((c) => this._s.delete(c)); },
    contains(c) { return this._s.has(c); },
    toggle(c, force) {
      if (force === undefined) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; }
      if (force) { this._s.add(c); return true; }
      this._s.delete(c); return false;
    },
  };
}

function parseAttrsInto(el, attrStr) {
  const attrRe = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let am;
  while ((am = attrRe.exec(attrStr))) {
    const name = am[1].toLowerCase();
    const val = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : '';
    el.attrs[name] = val;
  }
  if (el.attrs.class) el.attrs.class.split(/\s+/).filter(Boolean).forEach((c) => el.classList._s.add(c));
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    attrs: {},
    style: {},
    children: [],
    parentElement: null,
    _listeners: [],
    value: '',
    checked: false,
    disabled: false,
    _rect: null,
    get dataset() {
      const d = {};
      Object.keys(this.attrs).forEach((k) => {
        if (k.indexOf('data-') === 0) {
          const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          d[camel] = this.attrs[k];
        }
      });
      return d;
    },
    get id() { return this.attrs.id || ''; },
    set id(v) { this.attrs.id = v; },
    get className() { return this.attrs.class || ''; },
    set className(v) { this.attrs.class = v; this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set innerHTML(html) { this._html = html; const kids = parseHTML(html); kids.forEach((k) => { k.parentElement = this; }); this.children = kids; },
    get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; this.children = []; this._html = ''; },
    get textContent() { return this._text !== undefined ? this._text : ''; },
    setAttribute(k, v) { const key = String(k).toLowerCase(); this.attrs[key] = String(v); if (key === 'class') this.className = String(v); },
    getAttribute(k) { const key = String(k).toLowerCase(); return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; },
    removeAttribute(k) { delete this.attrs[String(k).toLowerCase()]; },
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    addEventListener(type, fn, opts) { this._listeners.push({ type, fn, opts }); },
    removeEventListener(type, fn) { this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn)); },
    querySelector(sel) { return queryAll(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(this, sel); },
    closest(sel) { let n = this; while (n) { if (matchesSelector(n, sel)) return n; n = n.parentElement; } return null; },
    contains(node) {
      if (node === this) return true;
      return this.children.some((c) => c === node || c.contains(node));
    },
    getBoundingClientRect() { return this._rect || { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    getContext() { return makeCtx(); },
    focus() {},
    click() { this._listeners.filter((l) => l.type === 'click').forEach((l) => l.fn({ target: this, preventDefault() {}, stopPropagation() {} })); },
  };
  el.classList = makeClassList(el);
  return el;
}

function parseHTML(html) {
  const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)([^<>]*?)(\/?)>/g;
  const rootFrame = { tagName: null, el: null, children: [] };
  const stack = [rootFrame];
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].indexOf('<!--') === 0) continue;
    if (m[1]) {
      const tn = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tn) { stack.length = i; break; }
      }
      continue;
    }
    const tagName = m[2].toLowerCase();
    const attrStr = m[3] || '';
    const selfClose = !!m[4] || VOID_TAGS.has(tagName);
    const el = makeEl(tagName);
    parseAttrsInto(el, attrStr);
    el.parentElement = stack[stack.length - 1].el || null;
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push({ tagName, el, children: el.children });
  }
  return rootFrame.children;
}

function matchesSimple(el, sel) {
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|#[\w-]+|\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  const tag = m[1];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const rest = m[2] || '';
  const partRe = /\.[\w-]+|#[\w-]+|\[[^\]]+\]/g;
  let pm;
  while ((pm = partRe.exec(rest))) {
    const part = pm[0];
    if (part[0] === '.') { if (!el.classList.contains(part.slice(1))) return false; }
    else if (part[0] === '#') { if ((el.attrs.id || '') !== part.slice(1)) return false; }
    else {
      const inner = part.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq === -1) { if (!(inner.trim() in el.attrs)) return false; }
      else {
        const key = inner.slice(0, eq).trim();
        const val = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (el.attrs[key] !== val) return false;
      }
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (parts.length === 1) return matchesSimple(el, parts[0]);
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  const ancestorSel = parts[parts.length - 2];
  let anc = el.parentElement;
  while (anc) {
    if (matchesSimple(anc, ancestorSel)) return true;
    anc = anc.parentElement;
  }
  return false;
}

function queryAll(root, selector) {
  const out = [];
  (function walk(node) {
    for (const c of node.children) {
      if (matchesSelector(c, selector)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

class FakeImage {
  constructor() {
    this.width = 800;
    this.height = 600;
    this.onload = null;
    this.onerror = null;
    this.crossOrigin = null;
    this._src = '';
  }
  set src(v) { this._src = v; if (typeof this.onload === 'function') this.onload(); }
  get src() { return this._src; }
}

function getListener(el, type) {
  const l = el._listeners.find((x) => x.type === type);
  return l && l.fn;
}

function flushMicrotasks() {
  return new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
}

/* ── build one fresh sandbox + a driver object over it ── */
function loadEditor() {
  const head = makeEl('head');
  const body = makeEl('body');
  const calls = { updateDoc: [], addDoc: [], uploadBytes: [], getDoc: [] };
  let getDocResponse = null; // set per-open by the test

  const documentObj = Object.assign(makeEl('document'), {
    body, head,
    readyState: 'complete',
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
  });

  const windowObj = Object.assign(makeEl('window'), {
    innerWidth: 1280,
    devicePixelRatio: 1,
    document: documentObj,
    auth: { currentUser: { uid: 'uid_test_1' } },
    db: {},
    storage: {},
    _userClaims: { companyId: 'company_test_1' },
    doc: (db, col, id) => ({ __col: col, __id: id }),
    collection: (db, col) => ({ __col: col }),
    getDoc: (ref) => { calls.getDoc.push(ref); return Promise.resolve({ exists: () => getDocResponse != null, data: () => getDocResponse || {} }); },
    updateDoc: (ref, data) => { calls.updateDoc.push({ ref, data }); return Promise.resolve(); },
    addDoc: (colRef, data) => { calls.addDoc.push({ colRef, data }); return Promise.resolve({ id: 'new_photo_id' }); },
    ref: (storage, p) => ({ __path: p }),
    uploadBytes: (ref, blob) => { calls.uploadBytes.push({ ref, blob }); return Promise.resolve({}); },
    getDownloadURL: () => Promise.resolve('https://example.test/flattened.jpg'),
    serverTimestamp: () => ({ __serverTimestamp: true }),
    nbdConfirm: () => Promise.resolve(true),
    confirm: () => true,
    prompt: () => '',
  });
  windowObj.window = windowObj;

  const sandbox = {
    window: windowObj,
    document: documentObj,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => { try { fn(); } catch (e) { /* toast teardown is best-effort */ } return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame: (fn) => { try { fn(); } catch (e) { /* rAF callback errors aren't this test's concern */ } return 0; },
    cancelAnimationFrame() {},
    Image: FakeImage,
    CanvasRenderingContext2D: function CanvasRenderingContext2D() {},
    URL: { createObjectURL: () => 'blob://x', revokeObjectURL() {} },
    fetch: () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }),
    navigator: {},
    prompt: () => '',
    confirm: () => true,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(EDITOR_SRC, ctx, { filename: 'photo-editor.js' });

  return {
    api: windowObj.NBDPhotoEditor,
    win: windowObj,
    body,
    calls,
    setGetDocResponse: (data) => { getDocResponse = data; },
    getRoot: () => body.children[body.children.length - 1] || null,
  };
}

/* ============================================================
   1. Open with no saved annotations, draw one, Save Tags,
      inspect the real updateDoc payload.
   ============================================================ */
group('DOM HARNESS — drawing a shape and Save Tags persists it');

let capturedAnnotations = null;

(async () => {
  const editor = loadEditor();
  editor.setGetDocResponse({
    damageType: '', severity: '', location: '', phase: 'Before', notes: '', tags: [],
    brightness: 0, contrast: 0, url: 'https://example.test/original.jpg', storagePath: 'photos/uid_test_1/lead1/orig.jpg',
  });

  let openErr = null;
  try {
    await editor.api.open('https://example.test/original.jpg', 'photo_1', 'lead_1', null, []);
  } catch (e) { openErr = e; }
  ok('editor opens with no thrown error', !openErr, openErr && (openErr.stack || String(openErr)));

  const root = editor.getRoot();
  ok('an editor overlay root is appended to document.body', !!root && root.classList.contains('nbd-editor-overlay'));
  if (!root) { report(); return; }

  const canvasArea = root.querySelector('.nbd-canvas-area');
  ok('the canvas area element is found via querySelector', !!canvasArea);
  const wrapper = root.querySelector('.nbd-canvas-wrapper');
  ok('the canvas wrapper element is found via querySelector', !!wrapper);

  const mousedown = canvasArea && getListener(canvasArea, 'mousedown');
  ok('a real mousedown handler is wired on the canvas area', typeof mousedown === 'function');
  if (!mousedown) { report(); return; }

  // mousemove/mouseup are wired on window (so drags survive leaving the canvas)
  const winMousemove = getListener(editor.win, 'mousemove');
  const winMouseup = getListener(editor.win, 'mouseup');
  ok('a real mousemove handler is wired on window', typeof winMousemove === 'function');
  ok('a real mouseup handler is wired on window', typeof winMouseup === 'function');

  // Default tool must be pen/arrow-family so a plain drag produces a shape.
  ok('default S.tool is pen (per TOOLS.PEN default in the state object)',
    EDITOR_SRC.indexOf("tool: TOOLS.PEN,") !== -1);

  if (mousedown && winMousemove && winMouseup) {
    mousedown({ clientX: 100, clientY: 100, button: 0, preventDefault() {} });
    winMousemove({ clientX: 140, clientY: 130 });
    winMouseup({ clientX: 140, clientY: 130 });
  }

  const annListBeforeSave = root.querySelector('#nbd-ann-list');
  ok('the annotation list panel exists', !!annListBeforeSave);
  ok('the annotation list reflects the drawn shape (not "No annotations yet")',
    !!annListBeforeSave && /nbd-ann-item/.test(annListBeforeSave.innerHTML) && !/No annotations yet/.test(annListBeforeSave.innerHTML),
    annListBeforeSave ? annListBeforeSave.innerHTML : '(no list found)');

  const saveTagsBtn = root.querySelector('[data-act="save-tags"]');
  ok('the Save Tags button is found via [data-act="save-tags"]', !!saveTagsBtn);
  const saveTagsClick = saveTagsBtn && getListener(saveTagsBtn, 'click');
  ok('the Save Tags button has a real click handler', typeof saveTagsClick === 'function');

  if (saveTagsClick) {
    saveTagsClick({ target: saveTagsBtn, preventDefault() {}, stopPropagation() {} });
  }
  await flushMicrotasks();

  ok('exactly one updateDoc call was made by Save Tags', editor.calls.updateDoc.length === 1,
    'updateDoc calls: ' + editor.calls.updateDoc.length);
  const payload = editor.calls.updateDoc[0] && editor.calls.updateDoc[0].data;
  ok('the updateDoc payload targets photo_1', editor.calls.updateDoc[0] && editor.calls.updateDoc[0].ref && editor.calls.updateDoc[0].ref.__id === 'photo_1');
  ok('the updateDoc payload has an annotations array', !!payload && Array.isArray(payload.annotations),
    payload ? JSON.stringify(payload) : '(no payload)');
  ok('the persisted annotations array has exactly ONE shape — the one just drawn',
    !!payload && Array.isArray(payload.annotations) && payload.annotations.length === 1,
    payload ? JSON.stringify(payload.annotations) : '(no payload)');
  ok('the persisted shape is JSON-safe (round-trips through JSON.stringify/parse cleanly)',
    !!payload && Array.isArray(payload.annotations) && JSON.stringify(JSON.parse(JSON.stringify(payload.annotations))) === JSON.stringify(payload.annotations));

  capturedAnnotations = payload && payload.annotations;

  /* ============================================================
     2. Re-open the SAME photo with getDoc now returning the
        annotations captured above. The shapes must come back —
        both into the render pipeline and into the annotation list UI.
     ============================================================ */
  group('DOM HARNESS — re-opening seeds annotations from Firestore instead of resetting to []');

  editor.setGetDocResponse({
    damageType: '', severity: '', location: '', phase: 'Before', notes: '', tags: [],
    brightness: 0, contrast: 0, annotations: capturedAnnotations,
    url: 'https://example.test/original.jpg', storagePath: 'photos/uid_test_1/lead1/orig.jpg',
  });

  let reopenErr = null;
  try {
    await editor.api.open('https://example.test/original.jpg', 'photo_1', 'lead_1', null, []);
  } catch (e) { reopenErr = e; }
  ok('re-opening the editor does not throw', !reopenErr, reopenErr && (reopenErr.stack || String(reopenErr)));

  const root2 = editor.getRoot();
  ok('a fresh editor overlay root is appended on re-open', !!root2 && root2 !== root);

  const annList2 = root2 && root2.querySelector('#nbd-ann-list');
  ok('the annotation list panel exists on re-open', !!annList2);
  ok('the annotation list on re-open reflects the ONE restored annotation (not the empty state)',
    !!annList2 && /nbd-ann-item/.test(annList2.innerHTML) && !/No annotations yet/.test(annList2.innerHTML),
    annList2 ? annList2.innerHTML : '(no list found)');

  const annItems2 = annList2 ? annList2.querySelectorAll('.nbd-ann-item') : [];
  ok('exactly one .nbd-ann-item element is rendered in the restored list',
    annItems2.length === 1, 'found ' + annItems2.length);

  report();
})().catch((e) => {
  console.error('\nFATAL', (e && e.stack) || e);
  process.exit(1);
});

function report() {
  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
}
