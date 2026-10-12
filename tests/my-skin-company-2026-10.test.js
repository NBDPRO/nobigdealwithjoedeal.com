/**
 * tests/my-skin-company-2026-10.test.js — My Skin company background sets
 * (spec section 18, slice B4): normalisation, the 8-step precedence, member
 * overrides, enforced floors, paths, rules text and the page contract. The
 * emulator cases (members, other companies, anonymous, offboardLock, viewer,
 * sales_rep, usage writes, the 220 bound) live in storage-rules.test.js and
 * firestore-rules.test.js.
 *
 * Run: node tests/my-skin-company-2026-10.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const L = require(path.join(ROOT, 'docs/pro/js/my-skin-logic.js'));
const C = 'co1';
const cimg = (id, theme) => ({ id: id, path: 'companies/' + C + '/skins/themes/' + (theme || 'pokemon') + '/' + id, v: 3, w: 10, h: 10, bytes: 9, type: 'image/webp' });
const pimg = (id, theme) => ({ id: id, path: 'skins/u1/themes/' + (theme || 'pokemon') + '/' + id, v: 1, w: 10, h: 10, bytes: 9, type: 'image/webp' });

console.log('\n1. normalizeCompany');
{
  ok('no doc → null', L.normalizeCompany(null) === null && L.normalizeCompany(undefined) === null);
  const co = L.normalizeCompany({
    enabled: true, allowHide: false, show: { interval: '1m', shuffle: true, fadeMs: 99999 },
    themes: { pokemon: { images: [cimg('lq3x9a1b2c')], mode: 'enforced', minDim: 9 }, mario: { images: [cimg('lq3x9a1b2d', 'mario')], mode: 'whatever' },
      'Bad Id': { images: [cimg('lq3x9a1b2e')] }, personal: { images: [pimg('lq3x9a1b2f')] } },
    all: { images: [cimg('lq3x9a1b2g', '_all')] },
    rightsAttestation: { by: 'u9', at: 5, text: 'v1' }, usage: { bytes: 7, count: 2, rejectedAt: 9 },
  });
  ok('switches, show defaults and fade clamp', co.enabled && co.allowHide === false && co.show.interval === '1m' && co.show.shuffle === true && co.show.fadeMs === 3000);
  ok('mode: only the literal "enforced" enforces; minDim clamps to 0.85', co.themes.pokemon.mode === 'enforced' && co.themes.pokemon.minDim === 0.85 && co.themes.mario.mode === 'suggested');
  ok('bad theme ids and a personal skins/ path inside a company set are dropped', Object.keys(co.themes).sort().join() === 'mario,pokemon');
  ok('the all-themes slot lives under _all', co.all && co.all.images[0].path.indexOf('/_all/') > 0);
  ok('the rights attestation and usage are read', co.rightsAttestation.text === 'v1' && co.usage.bytes === 7 && co.usage.rejectedAt === 9);
  ok('a bad attestation text counts as none', L.normalizeCompany({ enabled: true, rightsAttestation: { by: 'u', at: 1, text: 'v0' } }).rightsAttestation === null);
  ok('defaults: off until enabled, hiding allowed', L.normalizeCompany({}).enabled === false && L.normalizeCompany({}).allowHide === true);
  const m = L.normalize({ company: { show: false, hide: { pokemon: true, 'Bad Id': true, mario: 'yes' } }, hidePictures: true });
  ok('member prefs: show, a hide map of valid ids, hidePictures', m.company.show === false && Object.keys(m.company.hide).join() === 'pokemon' && m.hidePictures === true);
  ok('member defaults: company shown, pictures not hidden', L.normalize({}).company.show === true && L.normalize({}).hidePictures === false);
}

console.log('\n2. paths');
{
  ok('companyStoragePath builds the folder, the thumbnail and _all', L.companyStoragePath(C, 'pokemon', 'lq3x9a1b2c') === 'companies/co1/skins/themes/pokemon/lq3x9a1b2c'
    && L.companyStoragePath(C, '_all', 'lq3x9a1b2c', true) === 'companies/co1/skins/themes/_all/lq3x9a1b2c_t');
  ok('companyStoragePath refuses bad ids', L.companyStoragePath('a/b', 'pokemon', 'lq3x9a1b2c') === null && L.companyStoragePath(C, 'Poke', 'lq3x9a1b2c') === null && L.companyStoragePath(C, 'pokemon', 'ab') === null);
  ok('trustedCompanyImagePath: only the caller\'s own company folder',
    L.trustedCompanyImagePath(C, cimg('lq3x9a1b2c')) === 'companies/co1/skins/themes/pokemon/lq3x9a1b2c'
    && L.trustedCompanyImagePath('co2', cimg('lq3x9a1b2c')) === null
    && L.trustedCompanyImagePath(C, { path: 'skins/u1/themes/pokemon/lq3x9a1b2c' }) === null
    && L.trustedCompanyImagePath(C, { path: 'companies/co1/skins/themes/pokemon/../x' }) === null
    && L.trustedCompanyImagePath(null, cimg('lq3x9a1b2c')) === null);
  ok('a company path is never a trusted PERSONAL path (and the reverse)', L.trustedImagePath('u1', cimg('lq3x9a1b2c')) === null);
}

console.log('\n3. precedence (spec 18.4), one case per step');
{
  const base = { enabled: true, perTheme: true, dim: 0.5, slots: { wallpaper: { path: 'skins/u1/wallpaper', v: 1 } },
    themes: { pokemon: { images: [pimg('lq3x9a1b2c')], dim: 0.4 } }, allThemes: { imageRef: 'mario/lq3x9a1b2d', image: pimg('lq3x9a1b2d', 'mario') } };
  const co = (o) => L.normalizeCompany(Object.assign({ enabled: true, allowHide: true, themes: {}, all: null }, o));
  const set = (mode, theme) => ({ images: [cimg('lq3x9a1b2' + (mode === 'enforced' ? 'x' : 'y'), theme)], mode: mode });
  const R = (cfg, c, t) => L.resolveWithCompany(L.normalize(cfg), c, t);

  ok('1. enforced for the theme beats the member\'s own picture', R(base, co({ themes: { pokemon: set('enforced') } }), 'pokemon').origin === 'company-enforced');
  ok('2. enforced for every theme beats personal on a theme with its own picture', R(base, co({ all: set('enforced', '_all') }), 'pokemon').origin === 'company-enforced');
  ok('1 beats 2: a per-theme enforced set wins over the enforced-for-all set',
    R(base, co({ themes: { pokemon: set('enforced') }, all: set('enforced', '_all') }), 'pokemon').images[0].path.indexOf('/pokemon/') > 0);
  ok('3. personal theme set beats a SUGGESTED company set', R(base, co({ themes: { pokemon: set('suggested') } }), 'pokemon').origin === 'personal');
  ok('4. personal "use for all" beats suggested', R(base, co({ all: set('suggested', '_all') }), 'batman').origin === 'personal' && R(base, co({ all: set('suggested', '_all') }), 'batman').source === 'all');
  const noAll = Object.assign({}, base, { allThemes: null });
  ok('5. personal global wallpaper beats suggested', R(noAll, co({ themes: { batman: set('suggested', 'batman') } }), 'batman').origin === 'personal');
  const bare = { enabled: true, perTheme: true, themes: {}, slots: {} };
  ok('6. suggested for the theme paints when the member has nothing', R(bare, co({ themes: { batman: set('suggested', 'batman') } }), 'batman').origin === 'company-suggested');
  ok('7. suggested for every theme paints on a theme without its own', R(bare, co({ all: set('suggested', '_all') }), 'batman').origin === 'company-suggested');
  ok('6 beats 7', R(bare, co({ themes: { batman: set('suggested', 'batman') }, all: set('suggested', '_all') }), 'batman').images[0].path.indexOf('/batman/') > 0);
  ok('8. nothing anywhere → the theme\'s built-in art', R(bare, co({}), 'batman').origin === 'builtin' && R(bare, co({}), 'batman').source === 'none');
  ok('the company switch off → nothing from the company', R(bare, co({ enabled: false, themes: { batman: set('enforced', 'batman') } }), 'batman').origin === 'builtin');
  ok('no company doc at all → exactly the personal result', R(noAll, null, 'pokemon').origin === 'personal' && R(noAll, null, 'pokemon').source === 'theme');

  // members who never set My Skin up, and members who turned it off
  ok('a member who never set My Skin up (no doc) sees a suggested set', R({}, co({ all: set('suggested', '_all') }), 'batman').origin === 'company-suggested');
  const off = { enabled: false, perTheme: true, themes: { pokemon: base.themes.pokemon }, slots: {} };
  ok('My Skin OFF: a suggested set still paints (their own picture does not)', R(off, co({ themes: { pokemon: set('suggested') } }), 'pokemon').origin === 'company-suggested');
  ok('My Skin OFF: an enforced set paints too', R(off, co({ themes: { pokemon: set('enforced') } }), 'pokemon').origin === 'company-enforced');
  ok('"Hide background pictures" beats everything, enforced included',
    R(Object.assign({}, base, { hidePictures: true }), co({ themes: { pokemon: set('enforced') } }), 'pokemon').origin === 'builtin');

  // member switches
  const hid = Object.assign({}, bare, { company: { show: true, hide: { batman: true } } });
  ok('a member can hide a suggested picture for one theme', R(hid, co({ themes: { batman: set('suggested', 'batman') } }), 'batman').origin === 'builtin');
  ok('...but not an enforced one', R(hid, co({ themes: { batman: set('enforced', 'batman') } }), 'batman').origin === 'company-enforced');
  const offAll = Object.assign({}, bare, { company: { show: false, hide: {} } });
  ok('a member can turn company backgrounds off (suggested)', R(offAll, co({ all: set('suggested', '_all') }), 'batman').origin === 'builtin');
  ok('...only when the company allows it', R(offAll, co({ allowHide: false, all: set('suggested', '_all') }), 'batman').origin === 'company-suggested');
  ok('...and never for an enforced set', R(offAll, co({ all: set('enforced', '_all') }), 'batman').origin === 'company-enforced');
  ok('a hide flag is ignored when the company disallows hiding', R(hid, co({ allowHide: false, themes: { batman: set('suggested', 'batman') } }), 'batman').origin === 'company-suggested');
}

console.log('\n4. enforced floors and what a member can adjust');
{
  const co = L.normalizeCompany({ enabled: true, themes: { pokemon: { images: [cimg('lq3x9a1b2c')], mode: 'enforced', minDim: 0.7, dim: 0.5, blur: 2 } } });
  const mine = (t) => L.normalize({ enabled: true, perTheme: true, dim: 0.3, themes: { pokemon: Object.assign({ images: [pimg('lq3x9a1b2d')] }, t) } });
  let r = L.resolveWithCompany(mine({ dim: 0.2, blur: 0 }), co, 'pokemon');
  ok('a member cannot lower the dim below the company\'s minDim', r.dim === 0.7 && r.minDim === 0.7 && r.locked === true);
  r = L.resolveWithCompany(mine({ dim: 0.8, blur: 9 }), co, 'pokemon');
  ok('...but can raise dim and blur', r.dim === 0.8 && r.blur === 9);
  const eff = L.effectiveDim({ dim: 0.3, dimOverride: true, minDim: 0.7, blur: 0 }, { lumCenter: 0.9, avg: '#ffffff' }, { mode: 'dark', bg: '#000000', t: '#ffffff', m: '#999999' });
  const co2 = L.normalizeCompany({ enabled: true, themes: { pokemon: { images: [cimg('lq3x9a1b2c')], mode: 'enforced', dim: 0.5 } } });
  ok('with no minDim the company\'s own dim is the floor a member cannot go under',
    L.resolveWithCompany(mine({ dim: 0.1 }), co2, 'pokemon').dim === 0.5 && L.resolveWithCompany(mine({ dim: 0.6 }), co2, 'pokemon').dim === 0.6);
  ok('minDim holds even over "I understand"', eff.dim >= 0.7);
  ok('the readability guard still applies on top (a bright picture raises it further)', L.effectiveDim({ dim: 0.1, minDim: 0.5, blur: 0 }, { lumCenter: 0.9, avg: '#ffffff' }, { mode: 'dark', bg: '#000000', t: '#ffffff', m: '#999999' }).dim > 0.5);
  ok('company pictures hide the animated overlay by default', L.resolveWithCompany(mine({}), co, 'pokemon').hideOverlay === true);
}

console.log('\n5. rules text and page contract');
{
  const S = strip(read('storage.rules'));
  const m = S.match(/match \/companies\/\{companyId\}\/skins\/themes\/\{themeId\}\/\{imageId\} \{([\s\S]*?)\n    \}/);
  const b = m ? m[1] : '';
  ok('storage block exists, before the default deny', !!m && S.indexOf('match /companies/{companyId}/skins/themes/') < S.indexOf('match /{allPaths=**}'));
  ok('read: members of the company or platform admin only', /allow read: if isCompanyMember\(companyId\) \|\| isAdmin\(\);/.test(b));
  ok('write: that company\'s admin, ids shaped, < 3 MB, lossy only', /isCompanyAdminOf\(companyId\) \|\| isAdmin\(\)/.test(b)
    && /\(_all\|_custom\|\[a-z0-9-\]\{1,40\}\)/.test(b) && /\(_t\)\?\$/.test(b) && /size < 3 \* 1024 \* 1024/.test(b) && /image\/\(webp\|jpeg\)/.test(b) && !/png|svg/.test(b));
  const RAW = read('storage.rules');
  const helpers = RAW.slice(RAW.indexOf('function notLocked'), RAW.indexOf('function notLocked') + 900);
  ok('the helpers key off token claims, not Firestore lookups', /function isCompanyMember/.test(RAW) && /function isCompanyAdminOf/.test(RAW) && !/firestore\.get|get\(\/databases/.test(helpers));
  ok('offboardLock is denied for members and admins', /function notLocked\(\) \{ return request\.auth\.token\.get\('offboardLock', false\) != true; \}/.test(RAW));
  const F = strip(read('firestore.rules'));
  ok('firestore: skin/{docId} under companies, config only, usage guarded, 220 bound, no delete',
    /match \/skin\/\{docId\} \{/.test(F) && /docId == 'config' && notViewer\(\)/.test(F) && /hasAny\(\['usage', 'usageUpdatedAt'\]\)/.test(F)
    && /get\('themes', \{\}\)\.size\(\) <= 220/.test(F) && /allow delete: if false;/.test(F.slice(F.indexOf('match /skin/{docId}'), F.indexOf('match /skin/{docId}') + 900)));

  const J = strip(read('docs/pro/js/my-skin.js'));
  const T = strip(read('docs/pro/js/my-skin-company.js'));
  ok('members listen to ONE doc: companies/{id}/skin/config', /'companies', id, 'skin', 'config'/.test(J) && /window\.onSnapshot\(ref, take/.test(J));
  ok('company pictures are fetched only from the caller\'s company folder', /trustedCompanyImagePath\(companyId, img\)/.test(J));
  ok('company pictures are read with getBlob like personal ones (no token URL anywhere)', !/getDownloadURL/.test(J + T));
  ok('the cache key is uid-prefixed and company-marked', /uid \+ '\|co\|' \+ parts\[1\]/.test(J));
  ok('the sign-out purge forgets the company set', /companyCfg = null; companyId = null/.test(J));
  ok('precedence is resolved by NBDMySkinLogic.resolveWithCompany', /L\(\)\.resolveWithCompany\(/.test(J));
  ok('the team panel is lazy, admins only, and not on the page at boot', /my-skin-company\.js\?v=\d+/.test(J) && /isCompanyAdmin\(\)/.test(J) && !/my-skin-company/.test(read('docs/pro/dashboard.html')));
  ok('a first upload and every import need the rights tick', /if \(!c\.rightsAttestation\) \{ fail\('Confirm the rights statement first\.'\)/.test(T) && /text: 'v1'/.test(T));
  ok('the rights statement is the spec\'s wording', /owns or has permission to use these images, and to show them to everyone on my team\. NBD Pro stores them privately for this company and doesn’t review them\./.test(read('docs/pro/js/my-skin-company.js')));
  ok('the usage bar reads usage; the client never writes it', /c\.usage\.bytes/.test(T) && !/usage:/.test(T.replace(/c\.usage/g, '')));
  ok('a full company message and the 500 MB cap', /background storage is full/.test(T) && /COMPANY_CAP_BYTES/.test(T));
  ok('plain DOM only', !/innerHTML|outerHTML|insertAdjacentHTML/.test(T));
  ok('Hide background pictures is in the panel and saved', /myskinHidePictures/.test(read('docs/pro/dashboard.html')) && /hidePictures: cfg\.hidePictures/.test(J));
  ok('an enforced picture locks the controls but not dim and blur', /\[data-myskin-theme-file\]', '\[data-myskin-theme-clear\]'/.test(J.replace(/\\/g, '')) || /lock \|\| \(sel/.test(J));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
