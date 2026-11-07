// CRM audit 2026-11-06 — four small view fixes (VW-F110, VW-F164, VW-F165, VW-F168).
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

    // ── VW-F168: the installed app description names no company ─────
    const man = JSON.parse(read('docs/pro/manifest.json'));
    check('VW-F168: manifest description has no company name', !/No Big Deal/i.test(man.description || ''));
    check('VW-F168: manifest description is not empty', (man.description || '').trim().length > 0);

    console.log('\nviews-p3: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  })();
}
