/**
 * tests/pixel-world-2026-10-11.test.js — Pixel World v1 (CRM style roadmap E2).
 *
 *   1. pixel-world-logic.js: the map is connected (every door reachable from
 *      the start), movement and collision, camera, deterministic townspeople
 *      placement, wandering limits, hail flags, day/night tint, Lead Dex,
 *      area gates, the on/off switch, dialog facts
 *   2. contracts: the town is read-only (no Firestore write API, no network,
 *      no message send), lazy (not referenced by dashboard.html), original
 *      (no third-party game names), safe (no innerHTML), and its stylesheet
 *      uses tokens and honours both Reduce Motion switches
 *   3. pixel-mode-core.js launcher: switch parity with the logic module; the boot loader's layout seam
 *
 * Run: node tests/pixel-world-2026-10-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const PL = require(path.join(ROOT, 'docs/pro/js/pixel-logic.js'));
const WL = require(path.join(ROOT, 'docs/pro/js/pixel-world-logic.js'));
const MODE = require(path.join(ROOT, 'docs/pro/js/pixel-mode-core.js'));

console.log('\n1. pixel-world-logic');
{
  const world = WL.makeWorld();
  ok('map is W x H and fully populated', world.tiles.length === WL.W * WL.H && world.w === WL.W && world.h === WL.H);
  ok('the border is solid (nobody walks off the map)', (() => {
    for (let x = 0; x < world.w; x++) if (WL.walkable(world, x, 0) || WL.walkable(world, x, world.h - 1)) return false;
    for (let y = 0; y < world.h; y++) if (WL.walkable(world, 0, y) || WL.walkable(world, world.w - 1, y)) return false;
    return true;
  })());
  ok('out of bounds is never walkable', !WL.walkable(world, -1, 5) && !WL.walkable(world, 5, 999));
  ok('the start tile is walkable', WL.walkable(world, world.start.x, world.start.y));

  // BFS from the start over walkable tiles.
  const seen = new Set([world.start.x + ',' + world.start.y]);
  const q = [[world.start.x, world.start.y]];
  while (q.length) {
    const [x, y] = q.shift();
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (!seen.has(k) && WL.walkable(world, nx, ny)) { seen.add(k); q.push([nx, ny]); }
    });
  }
  ok('all six areas exist', WL.BUILDINGS.length === 6 && ['leads', 'workshop', 'tower', 'bank', 'trophy', 'office'].every((id) => WL.BUILDINGS.some((b) => b.id === id)));
  WL.BUILDINGS.forEach((b) => {
    ok('door of ' + b.id + ' is a door tile, walkable and reachable from the start',
      WL.tileAt(world, b.door.x, b.door.y) === WL.T.DOOR && seen.has(b.door.x + ',' + b.door.y));
    ok('footprint of ' + b.id + ' is solid except the door', (() => {
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        const isDoor = x === b.door.x && y === b.door.y;
        if (isDoor ? !WL.walkable(world, x, y) : WL.walkable(world, x, y)) return false;
      }
      return true;
    })());
  });
  ok('buildings do not overlap each other', WL.BUILDINGS.every((a, i) => WL.BUILDINGS.every((b, j) => i === j
    || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
  ok('buildingAtDoor finds it, and only on the door tile', (() => {
    const b = WL.BUILDINGS[0];
    return WL.buildingAtDoor(world, b.door.x, b.door.y) === b && WL.buildingAtDoor(world, b.door.x + 1, b.door.y) === null;
  })());

  // movement
  const open = { x: world.start.x, y: world.start.y };
  const r1 = WL.tryMove(world, open, 'right', new Set());
  ok('walks one tile onto open ground, facing set', r1.moved && r1.x === open.x + 1 && r1.facing === 'right');
  const r2 = WL.tryMove(world, open, 'right', new Set([(open.x + 1) + ',' + open.y]));
  ok('a person in the way blocks the step, but facing still turns', !r2.moved && r2.x === open.x && r2.facing === 'right');
  const wall = { x: 1, y: 5 };    // beside the border tree column
  const r3 = WL.tryMove(world, wall, 'left', new Set());
  ok('a tree/border blocks', !r3.moved && r3.x === 1);
  const b0 = WL.BUILDINGS[0];
  const above = { x: b0.door.x, y: b0.door.y + 1 };
  ok('cannot walk into a building wall, can walk into its door',
    !WL.tryMove(world, { x: b0.x - 1 + 0, y: b0.y + 1 }, 'right', new Set()).moved
    && WL.tryMove(world, above, 'up', new Set()).moved);
  ok('unknown direction does not move and defaults facing', (() => { const r = WL.tryMove(world, open, 'sideways', null); return !r.moved && r.facing === 'down'; })());

  // camera
  const cam0 = WL.cameraFor(0, 0, 240, 160, world);
  ok('camera clamps to the top-left', cam0.x === 0 && cam0.y === 0);
  const camEnd = WL.cameraFor(world.w - 1, world.h - 1, 240, 160, world);
  ok('camera clamps to the bottom-right', camEnd.x === world.w * 16 - 240 && camEnd.y === world.h * 16 - 160);
  const camMid = WL.cameraFor(20, 12, 240, 160, world);
  ok('camera centres on the player', camMid.x === 20 * 16 + 8 - 120 && camMid.y === 12 * 16 + 8 - 80);
  const camBig = WL.cameraFor(5, 5, 1000, 800, world);
  ok('a view larger than the map centres the map (negative offset)', camBig.x === -Math.round((1000 - 640) / 2) && camBig.y === -Math.round((800 - 384) / 2));

  // people
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 'lead-' + i, name: 'L' + i, pct: 50, tier: 'warn', overdue: i % 3 === 0 ? 2 : 0 }));
  const p1 = WL.placePeople(world, mk(30), 40);
  const p2 = WL.placePeople(world, mk(30), 40);
  ok('placement is deterministic (same lead, same tile, every visit)', JSON.stringify(p1.map((p) => [p.id, p.x, p.y])) === JSON.stringify(p2.map((p) => [p.id, p.x, p.y])));
  ok('no two people share a tile', new Set(p1.map((p) => p.x + ',' + p.y)).size === p1.length);
  ok('everyone stands on walkable ground, never a door, never the start tile',
    p1.every((p) => WL.walkable(world, p.x, p.y) && WL.tileAt(world, p.x, p.y) !== WL.T.DOOR && !(p.x === world.start.x && p.y === world.start.y)));
  ok('everyone is reachable from the start', p1.every((p) => seen.has(p.x + ',' + p.y)));
  ok('cap honoured, order preserved (most at risk keep their place)', WL.placePeople(world, mk(100), 12).length === 12 && WL.placePeople(world, mk(100), 12)[0].id === 'lead-0');
  const crowd = WL.placePeople(world, mk(400), 400);
  const spots = WL.plazaTiles(world).length;
  ok('a crowd fills the plaza without collisions, doors or the start tile (' + crowd.length + ' of ' + spots + ' spots)',
    crowd.length === Math.min(400, spots) && new Set(crowd.map((p) => p.x + ',' + p.y)).size === crowd.length
    && crowd.every((p) => WL.tileAt(world, p.x, p.y) !== WL.T.DOOR && WL.walkable(world, p.x, p.y) && !(p.x === world.start.x && p.y === world.start.y)));
  ok('empty party places nobody', WL.placePeople(world, [], 40).length === 0);

  const person = p1[0];
  let moved = 0;
  const rngs = [0.0, 0.3, 0.6, 0.9];
  rngs.forEach((r) => { const s = WL.wanderStep(world, person, () => r, new Set()); if (s) moved++; });
  ok('wandering only returns in-radius, walkable, non-door steps', rngs.every((r) => {
    const s = WL.wanderStep(world, person, () => r, new Set());
    return !s || (Math.abs(s.x - person.homeX) <= 3 && Math.abs(s.y - person.homeY) <= 3 && WL.walkable(world, s.x, s.y) && WL.tileAt(world, s.x, s.y) !== WL.T.DOOR);
  }));
  const far = Object.assign({}, person, { x: person.homeX + 3 });
  ok('a person at the edge of their radius will not step further out', WL.wanderStep(world, far, () => 0.9 /* right */, new Set()) === null || (WL.wanderStep(world, far, () => 0.9, new Set()).x <= far.homeX + 3));
  ok('personFacing finds the person on the faced tile', (() => {
    const t = WL.stepFrom({ x: person.x, y: person.y }, 'up');
    return WL.personFacing([person], { x: t.x, y: t.y }, 'down') === person && WL.personFacing([person], { x: t.x, y: t.y }, 'up') === null;
  })());
}

console.log('\n   status marks (overdue / hail) mapped from real lead data');
{
  const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();
  const day = 86400000;
  const leads = [
    { id: 'late', firstName: 'Lee', lastName: 'Late', stage: 'new', updatedAt: NOW - 3 * day, followUp: '2026-10-05', lat: 39.1, lng: -84.5 },
    { id: 'ok', firstName: 'Ok', lastName: 'Fine', stage: 'new', updatedAt: NOW - 1 * day, followUp: '2026-10-20', lat: 39.2, lng: -84.6 },
    { id: 'nocoord', firstName: 'No', lastName: 'Coords', stage: 'new', updatedAt: NOW },
  ];
  const members = PL.partyOf(leads, {}, NOW);
  const late = members.find((m) => m.id === 'late');
  ok('"!" = the lead\'s own follow-up date is before today', WL.markFor(late).bang === true && WL.markFor(members.find((m) => m.id === 'ok')).bang === false);
  const flagged = WL.flagHail(members, (lat) => (lat < 39.15 ? { hailPct: 15 } : null));
  ok('hail flag only where the outlook says so, and only with coordinates', flagged === 1 && late.hailPct === 15
    && members.find((m) => m.id === 'ok').hailPct === null && members.find((m) => m.id === 'nocoord').hailPct === null);
  ok('a throwing outlook flags nothing instead of crashing', WL.flagHail(members, () => { throw new Error('x'); }) === 0);
  ok('no outlook function = no flags', WL.flagHail(members, null) === 0);
  ok('a zero-percent outlook does not flag', WL.flagHail(members, () => ({ hailPct: 0 })) === 0);
}

console.log('\n   day and night');
{
  ok('noon has no tint', WL.dayTint(12).a === 0 && WL.dayTint(12).name === 'DAY');
  ok('midnight is the darkest', WL.dayTint(0).a === 0.5 && WL.dayTint(0).name === 'NIGHT');
  ok('wraps past 24 and below 0', WL.dayTint(36).a === WL.dayTint(12).a && WL.dayTint(-12).a === WL.dayTint(12).a);
  ok('dusk is between day and night', WL.dayTint(19).a > 0 && WL.dayTint(19).a < 0.5);
  let prev = WL.dayTint(0).a, maxJump = 0;
  for (let h = 0.1; h <= 24; h += 0.1) { const a = WL.dayTint(h).a; maxJump = Math.max(maxJump, Math.abs(a - prev)); prev = a; }
  ok('the tint changes smoothly through the day (no pops)', maxJump < 0.1, 'max jump ' + maxJump);
}

console.log('\n   Lead Dex, gates, switch');
{
  const stageRole = (k) => (k === 'signed' ? 'won' : 'active');
  const leads = [
    { id: 'b', firstName: 'Bea', stage: 'new', createdAt: 2000 },
    { id: 'a', firstName: 'Al', stage: 'new', createdAt: 1000 },
    { id: 'c', firstName: 'Cy', stage: 'signed', createdAt: 3000 },
    { id: 'gone', firstName: 'Del', stage: 'new', deleted: true, createdAt: 10 },
  ];
  const dex = WL.dexEntries(leads, ['b'], { stageRole });
  ok('numbered oldest first, deleted leads excluded', dex.map((d) => d.id).join(',') === 'a,b,c' && dex.map((d) => d.no).join(',') === '1,2,3');
  ok('states: unknown (name hidden), seen, caught (signed, even if never met)', dex[0].state === 'unknown' && dex[0].name === '???' && dex[1].state === 'seen' && dex[1].name === 'Bea' && dex[2].state === 'caught' && dex[2].name === 'Cy');
  const l1 = WL.markSeen([], 'x');
  ok('markSeen adds once and is idempotent', l1.length === 1 && WL.markSeen(l1, 'x') === l1);
  const big = Array.from({ length: WL.DEX_SEEN_CAP }, (_, i) => 'id' + i);
  const bigger = WL.markSeen(big, 'newest');
  ok('markSeen caps the list and keeps the newest', bigger.length === WL.DEX_SEEN_CAP && bigger[bigger.length - 1] === 'newest' && bigger[0] === 'id1');
  ok('gates follow ThemeEngine.isUnlocked and fail closed', WL.gateOpen('vault', (k) => k === 'gold-rush') === true && WL.gateOpen('vault', () => false) === false
    && WL.gateOpen('vault', () => { throw new Error('x'); }) === false && WL.gateOpen('nope', () => true) === false && WL.gateOpen('vault', null) === false);

  ok('switch: default OFF', WL.worldEnabled(undefined, null) === false && WL.worldEnabled({}, {}) === false);
  ok('switch: only a literal true counts', WL.worldEnabled({ pixelWorld: { enabled: 'true' } }, { enabled: 1 }) === false);
  ok('switch: the person opting in OR the company switch', WL.worldEnabled({ pixelWorld: { enabled: true } }, null) === true && WL.worldEnabled({}, { enabled: true }) === true);
  ok('company switch: owner and company_admin may set it; viewer, manager, other-company staff may not',
    WL.canSetCompanyFlag({}, 'u1') === true && WL.canSetCompanyFlag({ role: 'company_admin', companyId: 'c1' }, 'u2') === true
    && WL.canSetCompanyFlag({ role: 'viewer' }, 'u1') === false && WL.canSetCompanyFlag({ role: 'manager', companyId: 'c1' }, 'u2') === false
    && WL.canSetCompanyFlag({ role: 'sales_rep', companyId: 'c1' }, 'u2') === false && WL.canSetCompanyFlag({}, null) === false);

  const lines = WL.talkLines({ name: 'Dana W', stage: 'new', days: 12, pct: 14, overdue: 3, hailPct: 15 }, 'New Lead');
  ok('dialog states facts: stage, days, HP, overdue, hail risk', lines.length === 4 && /New Lead/.test(lines[0]) && /12 days/.test(lines[1]) && /14\/100/.test(lines[1]) && /3 days ago/.test(lines[2]) && /15% hail/.test(lines[3]));
  ok('dialog makes no promise about claims or outcomes', !/(claim|approved|guarantee|insurance will|we will get)/i.test(lines.join(' ')));
  ok('dialog: no touch on record', WL.talkLines({ name: 'X', stage: 'new', days: null, pct: null, overdue: 0, hailPct: null }, 'New')[1] === 'No touch on record yet.');
}

console.log('\n2. contracts');
{
  const game = read('docs/pro/js/pixel-world.js');
  const code = stripJs(game);
  ok('read-only: no Firestore write API in the town', !/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\b/.test(code));
  ok('the only write is the player\'s own seen list, through env.saveSeen', (code.match(/saveSeen/g) || []).length >= 2 && !/pixelWorld/.test(code));
  ok('no network from the town', !/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(code));
  ok('never sends a message (no sms/email/send helpers)', !/\b(sendSms|sendText|sendEmail|sendMessage|mailto:|sms:)/i.test(code));
  ok('the only outbound link is tel: (a Call button the person taps)', /'tel:'/.test(code) && !/https?:\/\//.test(code));
  ok('Draft text and Move stage are present but disabled in v1', /DRAFT TEXT', disabled: true/.test(code) && /MOVE STAGE', disabled: true/.test(code));
  ok('no innerHTML / document.write / eval', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(code));
  ok('no localStorage', !/localStorage|sessionStorage/.test(code));
  ok('Reduce Motion: wandering, bob, water shimmer, hail and typewriter all gated', (code.match(/reduce\(\)/g) || []).length >= 5);
  ok('lead names reach the DOM through textContent / createTextNode only', /el\('span', 'pxw-rname', m\.name\)/.test(code) && !/\+ m\.name \+ .*innerHTML/.test(code));

  const all = ['docs/pro/js/pixel-world.js', 'docs/pro/js/pixel-world-logic.js', 'docs/pro/js/pixel-mode.js', 'docs/pro/js/pixel-logic.js', 'docs/pro/css/pixel-world.css', 'docs/pro/css/pixel-mode.css']
    .map((f) => [f, stripJs(read(f)) + '\n' + stripCss(read(f))]);
  const banned = /pok[eé]mon|pikachu|nintendo|mario|zelda|\bsonic\b|game ?boy|kirby|poké|pokeball/i;
  ok('original art: no third-party game names in any Pixel Mode / Pixel World file',
    all.every(([f, c]) => !banned.test(c)), all.filter(([f, c]) => banned.test(c)).map(([f]) => f).join(', '));

  const html = read('docs/pro/dashboard.html').replace(/<!--[\s\S]*?-->/g, '');
  ok('lazy: the dashboard references neither the game, its logic nor its CSS', !/pixel-world(-logic)?\.(js|css)/.test(html));
  const mode = read('docs/pro/js/pixel-mode-core.js');
  ok('lazy: the launcher fetches the game only inside openWorld → worldAssets', /function worldAssets\(\)/.test(mode) && (mode.match(/WORLD_JS_URL/g) || []).length === 2);
  ok('the launcher checks the switch before it loads anything', /if \(!worldEnabled\(\)\) \{[\s\S]{0,200}return null;/.test(mode));

  const css = stripCss(read('docs/pro/css/pixel-world.css'));
  const lits = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ['docs/pro/css/pixel-world.css', 'docs/pro/css/pixel-mode.css'].forEach((f) => ok(f.split('/').pop() + ': nothing is centred with a transform (dashboard-app.css strips transforms from :hover ancestors on touch, which moved boxes out from under a tap)', !/translate[XY]?\(\s*-50%/.test(stripCss(read(f)))));
  ok('frame CSS: no hex colour literals (theme tokens only)', lits.length === 0, lits.join(' '));
  ok('frame CSS: Reduce Motion (OS + app switch) removes the HP transition', /html\[data-motion="reduce"\] \.pxw-hp > i\s*\{\s*transition:\s*none/.test(css) && /prefers-reduced-motion: reduce\)\s*\{\s*\.pxw-hp > i\s*\{\s*transition:\s*none/.test(css));
  ok('frame CSS: the D-pad shows on touch and narrow screens', /pointer: coarse\), \(max-width: 760px\)/.test(css) && /\.pxw-key\s*\{[^}]*min-height:\s*56px/.test(css));
  ok('frame CSS: touch targets are at least 40px', /\.pxw-btn\s*\{[^}]*min-height:\s*40px/.test(css) && /\.pxw-opt\s*\{[^}]*min-height:\s*40px/.test(css));
}

console.log('\n3. launcher parity');
{
  const users = [undefined, null, {}, { enabled: true }, { enabled: 'true' }, { enabled: 1 }];
  const cos = [undefined, null, {}, { enabled: true }, { enabled: 'yes' }];
  ok('worldOn agrees with the logic module for every shape',
    users.every((u) => cos.every((c) => MODE.worldOn(u, c) === WL.worldEnabled(u ? { pixelWorld: u } : undefined, c))));
  const claims = [{}, { role: 'viewer' }, { role: 'manager', companyId: 'c' }, { role: 'company_admin', companyId: 'c' }, { role: 'admin' }, { role: 'sales_rep', companyId: 'c' }, { companyId: 'u1' }];
  ok('canSetCompany agrees with the logic module', claims.every((c) => ['u1', 'u2', null].every((u) => MODE.canSetCompany(c, u) === WL.canSetCompanyFlag(c, u))));
}

{
  const loader = stripJs(read('docs/pro/js/pixel-mode.js'));
  ok('boot loader exposes open() and fetches the core for it (no game code at boot)', /open: function \(\) \{ return viaCore\('open'\)/.test(loader) && !/pixel-world/.test(loader));
  ok('layout seam: registers layout "pixel" with the registry only if it exists, and is thin (load/mount/unmount via the core)',
    /window|w\.LayoutRegistry/.test(loader) && /id: 'pixel'/.test(loader) && /R\.register\(\{/.test(loader) && /mount: function \(\) \{ return viaCore\('open'\)/.test(loader) && /unmount: function \(\) \{ return viaCore\('close'\)/.test(loader));
  ok('the core no longer registers a layout (the loader owns it, so there is no double registration)', !/LayoutRegistry/.test(stripJs(read('docs/pro/js/pixel-mode-core.js'))));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
