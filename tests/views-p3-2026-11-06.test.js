// CRM audit 2026-11-06 — seven small view fixes (VW-F108, VW-F109, VW-F110, VW-F163, VW-F164, VW-F165, VW-F168).
// Each check executes the shipped code where it can, so a revert fails here.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}

// ── VW-F110: photo-review error text is escaped ──────────────────────
{
  const src = read('docs/pro/js/pages/photo-review.js');
  const line = src.split(/\r?\n/).find(l => l.includes("Couldn\\'t load photos"));
  check('VW-F110: the photo-review error line exists', !!line);
  check('VW-F110: err.message goes through esc()', !!line && /esc\(\s*err\b/.test(line) && !/\+\s*err\.message\s*\+/.test(line));
  // esc() itself turns markup into text.
  const m = src.match(/function esc\(s\)\s*\{[\s\S]*?\n\}/);
  let escOut = '';
  if (m) { const ctx = {}; vm.runInNewContext(m[0] + '; out = esc("<img src=x onerror=alert(1)>");', ctx); escOut = ctx.out; }
  check('VW-F110: esc() neutralises a tag', escOut.length > 0 && !escOut.includes('<img'));
}

// ── VW-F164: the Thursday empty state names NBD's line only for NBD ──
{
  const src = read('docs/pro/js/widgets.js');
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex(l => l.includes('No calls yet. When Thursday answers'));
  check('VW-F164: the Thursday empty state exists', i >= 0);
  const block = i >= 0 ? lines.slice(Math.max(0, i - 2), i + 1).join('\n') : '';
  function render(isNbd) {
    const el = { innerHTML: '' };
    const window = { _isNbdPlatformTenant: () => isNbd };
    try { vm.runInNewContext(block, { window, el }); } catch (e) { return 'ERR ' + e.message; }
    return el.innerHTML;
  }
  const nbd = render(true), other = render(false);
  check('VW-F164: NBD still sees (513) 940-5589', nbd.includes('(513) 940-5589'));
  check('VW-F164: another company never sees NBD\'s number', !other.includes('940-5589') && other.includes('No calls yet'));
}

// ── VW-F165: a failed stats read is not "no drafts yet" ──────────────
{
  const src = read('docs/pro/js/ai-texting-stats-card.js');
  const window = {
    _functions: {},
    _httpsCallable: () => () => Promise.reject(new Error('offline')),
  };
  const host = { innerHTML: '', isConnected: true };
  const document = { getElementById: () => host, createElement: () => host };
  const ctx = { window, document, console: { warn() {}, log() {} }, setTimeout, Promise };
  ctx.window.window = ctx.window;
  let loaded = true;
  try { vm.runInNewContext(src, ctx); } catch (e) { loaded = false; }
  const card = ctx.window.AiTextingStatsCard;
  check('VW-F165: the card module loads', loaded && !!card);
  (async () => {
    let html = '';
    if (card) {
      try { await card.render(host); } catch (_) {}
      await new Promise(r => setTimeout(r, 20));
      html = host.innerHTML;
    }
    check('VW-F165: a failed read says it could not load', /Couldn.t load AI texting stats/.test(html));
    check('VW-F165: a failed read does not claim "No AI reply drafts yet"', html.length > 0 && !html.includes('No AI reply drafts yet'));
    check('VW-F165: the empty (no drafts) copy is still there', src.includes('No AI reply drafts yet'));

    // ── VW-F108 / VW-F109: shared helper — lift one top-level function ──
    function lift(src, name) {
      const lines = src.split(/\r?\n/);
      const i = lines.findIndex(l => new RegExp('^(async )?function ' + name + '\\(').test(l));
      if (i < 0) return '';
      if (/\}\s*(\/\/.*)?$/.test(lines[i]) && lines[i].split('{').length === lines[i].split('}').length) return lines[i];
      const j = lines.findIndex((l, k) => k > i && /^\}/.test(l));
      return lines.slice(i, j + 1).join('\n');
    }

    // ── VW-F108: social studio settings error + AI caption failures ──
    {
      const ss = read('docs/pro/js/pages/social-studio.js');
      const sub = lift(ss, 'subscribe');
      const toasts = [], disabled = [];
      const els = ['ssEnabled', 'ssReels', 'p1'].map(id => ({ id, disabled: false }));
      const sctx = {
        state: { companyId: 'c1', settings: {} }, db: {},
        query: () => ({}), collection: () => ({}), limit: () => ({}), doc: () => ({ settings: true }),
        onSnapshot: (ref, ok, bad) => { if (ref && ref.settings && bad) bad(new Error('permission-denied')); },
        $: () => ({ innerHTML: '' }), esc: (x) => String(x),
        toast: (m) => toasts.push(m), renderSettings() {}, renderSub() {},
        document: { querySelectorAll: () => els },
        console: { error() {}, warn() {}, log() {} },
      };
      let ran = true;
      try { vm.runInNewContext(sub + '\nsubscribe();', sctx); } catch (e) { ran = false; }
      check('VW-F108: the settings listener has a real error callback', ran && toasts.some(m => /could not load your auto-publish settings/i.test(m)));
      check('VW-F108: a failed settings read locks the toggles', els.every(e => e.disabled === true));

      const ai = lift(ss, 'aiPassForCreated');
      const actx = {
        state: { byId: new Map([['a', { status: 'draft' }], ['b', { status: 'draft' }]]) },
        aiCaption: async () => 'A caption.', postRef: (id) => id, serverTimestamp: () => 0,
        updateDoc: async (id) => { if (id === 'b') throw new Error('offline'); },
        console: { warn() {}, log() {} },
      };
      vm.runInNewContext(ai + '\nout = aiPassForCreated([{ id: "a" }, { id: "b" }]);', actx);
      const res = await actx.out;
      check('VW-F108: a failed caption write is counted', !!res && res.failed === 1 && res.used === true);
      check('VW-F108: the drafts toast reports a caption that did not save', /ai\.failed/.test(ss) && /did not save/.test(ss));
    }

    // ── VW-F109: Codex save/load tell the user when storage fails ────
    {
      const cx = read('docs/pro/js/ai-tool-finder-page-2.js');
      const toasts = [];
      const cctx = {
        window: { storage: { set: async () => { throw new Error('QuotaExceededError'); }, get: async () => ({ value: '{not json' }) } },
        codex: { tasks: [], sessions: [], directives: [] },
        toast: (m, t) => toasts.push([m, t]), console: { warn() {}, log() {} }, JSON,
      };
      vm.runInNewContext(lift(cx, 'save') + '\n' + lift(cx, 'load') + '\nout = save().then(load);', cctx);
      await cctx.out;
      check('VW-F109: a failed save shows an error toast', toasts.some(([m, t]) => /couldn.t save/i.test(m) && t === 'red'));
      check('VW-F109: an unreadable saved copy shows an error toast', toasts.some(([m, t]) => /couldn.t be read/i.test(m) && t === 'red'));
    }

    // ── VW-F163: the CSV import modal is keyboard-usable ─────────────
    {
      const di = read('docs/pro/js/data-import.js');
      const zoneTag = (di.match(/<div id="nbd-drop-zone"[^>]*>/) || [''])[0];
      check('VW-F163: the drop zone is focusable as a button', /role="button"/.test(zoneTag) && /tabindex="0"/.test(zoneTag) && /aria-label="[^"]+"/.test(zoneTag));
      const kd = (di.match(/zone\.addEventListener\('keydown',[\s\S]*?\n\s*\}\);/) || [''])[0];
      let clicks = 0, prevented = 0;
      const handlers = {};
      const zone = { addEventListener: (t, fn) => { handlers[t] = fn; } };
      const input = { click: () => { clicks++; } };
      if (kd) vm.runInNewContext(kd, { zone, input });
      const press = (key) => handlers.keydown && handlers.keydown({ key, preventDefault: () => { prevented++; } });
      press('Enter'); press(' '); press('a');
      check('VW-F163: Enter and Space open the file picker, other keys do not', clicks === 2 && prevented === 2);
      check('VW-F163: the modal joins the shared dialog contract (Escape, Tab trap, focus return)',
        /window\.nbdOverlay\.attach\(modalEl,\s*\{[^}]*close:\s*closeImport/.test(di));
    }

    // ── VW-F168: the installed app description names no company ─────
    const man = JSON.parse(read('docs/pro/manifest.json'));
    check('VW-F168: manifest description has no company name', !/No Big Deal/i.test(man.description || ''));
    check('VW-F168: manifest description is not empty', (man.description || '').trim().length > 0);

    console.log('\nviews-p3: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  })();
}
