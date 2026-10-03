/**
 * roof-rep.js — Roof Rep, the NBD Pro roofing-sales game (Jo, 2026-10-03).
 *
 * One rep, one day at a time: knock doors, inspect honestly, price from the
 * real price book, work the claim the Kentucky way (the homeowner owns the
 * claim; no deductible games; no money up front), schedule and run builds,
 * and collect. Training, seasons, a storm-chasing rival, boss doors, phone
 * calls, trophies and a company-only crew board round it out.
 *
 * The trap lines ("I'll handle your claim", "I'll cover your deductible", …)
 * are deliberate WRONG answers; tests/roof-rep-game-2026-10-03.test.js pins
 * that every one of them loses the door or breaks the clean-day streak.
 *
 * Page: /pro/roof-rep.html. Storage: localStorage cache + roofRep/{uid};
 * crew board: roofRepScores (same company). See js/pages/roof-rep-net.js.
 * Source of truth for content: the published claude.ai artifact; this file
 * is generated from it (keep the two in step).
 */
'use strict';
// ════════════════════════════════════════════════════════════════════════
// The avatar: the same 32×32 chibi as the NBD Pro game card.
// ════════════════════════════════════════════════════════════════════════
var C = {
  skin: ['#FBD9C0', '#F2C6A0', '#D99A6C', '#B97A4E', '#8D5A36', '#5E3B23'],
  hair: ['#2C2420', '#5A3A22', '#A0612B', '#E0B45A', '#C2452D', '#9AA0A6'],
  color: ['#F2A900', '#378ADD', '#E24B4A', '#639922', '#F5F5F0', '#2C2C2A'],
  shirt: ['#185FA5', '#D85A30', '#5F5E5A', '#0F6E56', '#7F4FB0', '#E8E4DA'],
  pants: ['#2E3A59', '#5C4A32', '#3D3D3A', '#6B7B8C'],
};
var OPTIONS = {
  skin: { label: 'Skin', colors: C.skin },
  hair: { label: 'Hair', values: [['short', 'Short'], ['spiky', 'Spiky'], ['long', 'Long'], ['buzz', 'Buzz'], ['ponytail', 'Ponytail'], ['bald', 'Bald']] },
  hairColor: { label: 'Hair color', colors: C.hair },
  eyes: { label: 'Eyes', values: [['round', 'Bright'], ['happy', 'Happy'], ['wink', 'Wink'], ['sleepy', 'Chill']] },
  hat: { label: 'Headwear', values: [['hardhat', 'Hard hat'], ['cap', 'Ball cap'], ['beanie', 'Beanie'], ['none', 'None']] },
  hatColor: { label: 'Headwear color', colors: C.color },
  beard: { label: 'Beard', values: [['none', 'None'], ['stubble', 'Stubble'], ['mustache', 'Mustache'], ['full', 'Full']] },
  shirt: { label: 'Shirt', colors: C.shirt },
  vest: { label: 'Hi-vis vest', values: [['none', 'No'], ['yes', 'Yes']] },
  pants: { label: 'Pants', colors: C.pants },
  tool: { label: 'Tool', values: [['hammer', 'Hammer'], ['tape', 'Tape'], ['ladder', 'Ladder'], ['none', 'None']] },
  extra: { label: 'Extras', values: [['none', 'None'], ['glasses', 'Safety glasses'], ['shades', 'Shades'], ['belt', 'Tool belt']] },
};
var DEFAULTS = { skin: 1, hair: 'short', hairColor: 1, eyes: 'round', hat: 'hardhat', hatColor: 0, beard: 'none', shirt: 0, vest: 'yes', pants: 0, tool: 'hammer', extra: 'none' };
// Gear you earn: option → level it unlocks at.
var LOCKS = { 'hat:beanie': 2, 'tool:ladder': 2, 'hair:spiky': 3, 'extra:shades': 3, 'extra:belt': 4, 'beard:full': 4, 'hatColor:5': 5, 'shirt:4': 6 };

function pickv(list, v, d) { return list.indexOf(v) >= 0 ? v : d; }
function idx(n, len, d) { n = Number(n); return Number.isInteger(n) && n >= 0 && n < len ? n : d; }
function normalize(a) {
  a = a || {};
  var vals = function (k) { return OPTIONS[k].values.map(function (v) { return v[0]; }); };
  return {
    skin: idx(a.skin, C.skin.length, DEFAULTS.skin), hair: pickv(vals('hair'), a.hair, DEFAULTS.hair),
    hairColor: idx(a.hairColor, C.hair.length, DEFAULTS.hairColor), eyes: pickv(vals('eyes'), a.eyes, DEFAULTS.eyes),
    hat: pickv(vals('hat'), a.hat, DEFAULTS.hat), hatColor: idx(a.hatColor, C.color.length, DEFAULTS.hatColor),
    beard: pickv(vals('beard'), a.beard, DEFAULTS.beard), shirt: idx(a.shirt, C.shirt.length, DEFAULTS.shirt),
    vest: pickv(vals('vest'), a.vest, DEFAULTS.vest), pants: idx(a.pants, C.pants.length, DEFAULTS.pants),
    tool: pickv(vals('tool'), a.tool, DEFAULTS.tool), extra: pickv(vals('extra'), a.extra, DEFAULTS.extra),
  };
}
function shade(hex, amt) {
  var n = parseInt(hex.slice(1), 16);
  var r = Math.max(0, Math.min(255, (n >> 16) + amt)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt)), b = Math.max(0, Math.min(255, (n & 255) + amt));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function build(a) {
  var G = []; for (var i = 0; i < 32; i++) G.push(new Array(32).fill(null));
  var set = function (x, y, c) { if (x >= 0 && x < 32 && y >= 0 && y < 32) G[y][x] = c; };
  var rect = function (x0, y0, x1, y1, c) { for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) set(x, y, c); };
  var row = function (y, x0, x1, c) { rect(x0, y, x1, y, c); };
  var skin = C.skin[a.skin], skinD = shade(skin, -28);
  var hair = C.hair[a.hairColor], hairD = shade(hair, -30), hairL = shade(hair, 30);
  var hatC = C.color[a.hatColor], hatD = shade(hatC, -40), hatL = shade(hatC, 35);
  var shirt = C.shirt[a.shirt], shirtD = shade(shirt, -35);
  var pants = C.pants[a.pants], pantsD = shade(pants, -25);
  var ink = '#2A2320', white = '#FFFFFF', blush = '#F29A9A';
  rect(14, 21, 17, 22, skinD); rect(11, 22, 20, 27, shirt); rect(11, 26, 20, 27, shirtD);
  rect(9, 23, 10, 26, shirt); rect(21, 23, 22, 26, shirt); rect(9, 27, 10, 27, skin); rect(21, 27, 22, 27, skin);
  if (a.vest === 'yes') { rect(11, 22, 13, 27, '#C6E11C'); rect(18, 22, 20, 27, '#C6E11C'); row(25, 11, 13, '#D7D7D7'); row(25, 18, 20, '#D7D7D7'); rect(13, 26, 13, 27, '#9DB51A'); rect(18, 26, 18, 27, '#9DB51A'); }
  if (a.extra === 'belt') { row(27, 11, 20, '#7A4A22'); set(15, 27, '#E0B45A'); set(16, 27, '#E0B45A'); set(12, 28, '#9AA0A6'); set(19, 28, '#7A4A22'); }
  if (a.clipboard) { rect(5, 21, 9, 27, '#B98A4E'); rect(6, 22, 8, 26, '#F5F5F0'); row(21, 6, 8, '#8A8F96'); }
  rect(12, 28, 14, 29, pants); rect(17, 28, 19, 29, pants); set(14, 29, pantsD); set(17, 29, pantsD);
  rect(11, 30, 14, 30, '#4A3424'); rect(17, 30, 20, 30, '#4A3424');
  row(6, 10, 21, skin); row(7, 9, 22, skin); rect(8, 8, 23, 18, skin); row(19, 9, 22, skin); row(20, 10, 21, skin); row(20, 11, 20, skinD);
  rect(7, 12, 7, 14, skin); rect(24, 12, 24, 14, skin); set(7, 13, skinD); set(24, 13, skinD);
  var top = function () { row(4, 11, 20, hair); row(5, 9, 22, hair); rect(8, 6, 23, 8, hair); set(12, 4, hairL); set(13, 5, hairL); };
  if (a.hair === 'short') { top(); rect(8, 9, 8, 11, hair); rect(23, 9, 23, 11, hair); row(9, 9, 11, hair); row(9, 20, 22, hair); set(14, 9, hairD); }
  else if (a.hair === 'spiky') { top(); if (a.hat === 'none') [10, 13, 16, 19].forEach(function (x) { set(x, 3, hair); set(x + 1, 2, hair); set(x + 1, 3, hair); }); rect(8, 9, 8, 10, hair); rect(23, 9, 23, 10, hair); }
  else if (a.hair === 'long') { top(); rect(7, 8, 8, 19, hair); rect(23, 8, 24, 19, hair); rect(7, 18, 8, 19, hairD); rect(23, 18, 24, 19, hairD); row(9, 9, 13, hair); }
  else if (a.hair === 'buzz') { row(5, 11, 20, hairD); rect(9, 6, 22, 7, hairD); }
  else if (a.hair === 'ponytail') { top(); rect(8, 9, 8, 11, hair); rect(23, 9, 23, 11, hair); rect(24, 6, 26, 8, hair); rect(25, 9, 26, 13, hair); set(26, 14, hairD); set(24, 6, hairL); }
  if (a.hat === 'hardhat') { row(2, 12, 19, hatC); row(3, 10, 21, hatC); rect(9, 4, 22, 7, hatC); rect(15, 2, 16, 7, hatL); row(8, 6, 25, hatD); row(7, 7, 24, hatC); set(11, 4, hatL); set(12, 3, hatL); }
  else if (a.hat === 'cap') { row(3, 11, 20, hatC); row(4, 9, 22, hatC); rect(8, 5, 23, 8, hatC); row(8, 8, 27, hatD); row(9, 21, 28, hatD); set(15, 3, hatL); set(16, 3, hatL); set(15, 5, white); set(16, 5, white); }
  else if (a.hat === 'beanie') { set(15, 1, hatL); set(16, 1, hatL); rect(14, 2, 17, 2, hatC); row(3, 11, 20, hatC); row(4, 9, 22, hatC); rect(8, 5, 23, 7, hatC); rect(8, 8, 23, 9, hatD); for (var bx = 9; bx <= 22; bx += 2) set(bx, 8, hatC); }
  var eyeL = 11, eyeR = 19, ey = 13;
  var roundEye = function (x) { rect(x, ey, x + 1, ey + 2, ink); set(x, ey, white); set(x + 1, ey + 2, '#5A4A44'); };
  var happyEye = function (x) { set(x - 1, ey + 2, ink); set(x, ey + 1, ink); set(x + 1, ey + 1, ink); set(x + 2, ey + 2, ink); };
  var eyes = function () {
    if (a.eyes === 'round') { roundEye(eyeL); roundEye(eyeR); }
    else if (a.eyes === 'happy') { happyEye(eyeL); happyEye(eyeR); }
    else if (a.eyes === 'wink') { roundEye(eyeL); row(ey + 2, eyeR - 1, eyeR + 2, ink); }
    else { row(ey + 1, eyeL - 1, eyeL + 2, ink); row(ey + 1, eyeR - 1, eyeR + 2, ink); set(eyeL, ey + 2, ink); set(eyeR + 1, ey + 2, ink); }
  };
  eyes();
  var brow = a.hair === 'bald' ? skinD : hairD;
  if (a.mouth === 'frown') { row(11, eyeL - 1, eyeL, brow); set(eyeL + 1, 12, brow); row(11, eyeR + 1, eyeR + 2, brow); set(eyeR, 12, brow); }
  else { row(11, eyeL - 1, eyeL + 1, brow); row(11, eyeR, eyeR + 2, brow); }
  if (a.mouth !== 'frown') { set(9, 16, blush); set(10, 16, blush); set(21, 16, blush); set(22, 16, blush); }
  if (a.mouth === 'frown') { set(14, 18, ink); set(15, 17, ink); set(16, 17, ink); set(17, 18, ink); }
  else { set(14, 17, ink); set(15, 18, ink); set(16, 18, ink); set(17, 17, ink); }
  if (a.beard === 'stubble') { for (var sx = 10; sx <= 21; sx += 2) { set(sx, 19, hairD); set(sx + 1, 20, hairD); } }
  else if (a.beard === 'mustache') { row(17, 13, 18, hair); set(12, 18, hair); set(19, 18, hair); set(15, 18, ink); set(16, 18, ink); }
  else if (a.beard === 'full') { rect(8, 16, 9, 19, hair); rect(22, 16, 23, 19, hair); row(19, 9, 22, hair); row(20, 10, 21, hair); row(21, 12, 19, hairD); row(17, 13, 18, hair); set(15, 18, ink); set(16, 18, ink); }
  if (a.extra === 'glasses') { rect(eyeL - 1, ey - 1, eyeL + 2, ey + 3, '#9CD3F0'); rect(eyeR - 1, ey - 1, eyeR + 2, ey + 3, '#9CD3F0'); row(ey, eyeL + 3, eyeR - 2, '#6B7B8C'); set(8, ey, '#6B7B8C'); set(23, ey, '#6B7B8C'); eyes(); }
  else if (a.extra === 'shades') { rect(eyeL - 1, ey, eyeL + 2, ey + 2, ink); rect(eyeR - 1, ey, eyeR + 2, ey + 2, ink); row(ey, eyeL + 3, eyeR - 2, ink); set(eyeL - 1, ey, '#6B7B8C'); set(eyeR - 1, ey, '#6B7B8C'); }
  if (a.tool === 'hammer') { rect(24, 20, 24, 28, '#8B5A2B'); set(24, 28, '#6B4423'); rect(22, 18, 26, 19, '#8A8F96'); set(26, 19, '#5F6368'); set(22, 18, '#B4B8BD'); set(23, 27, skin); }
  else if (a.tool === 'tape') { rect(23, 24, 27, 28, '#F2C200'); rect(24, 25, 26, 27, '#2C2C2A'); set(25, 26, '#F2C200'); row(28, 27, 30, '#E8E4DA'); set(23, 27, skin); }
  else if (a.tool === 'ladder') { for (var ly = 10; ly <= 30; ly++) { set(25, ly, '#B4B2A9'); set(29, ly, '#B4B2A9'); } for (var ry = 12; ry <= 30; ry += 3) row(ry, 26, 28, '#8F8D86'); }
  return G;
}
function outline(G) {
  var out = G.map(function (r) { return r.slice(); });
  for (var y = 0; y < 32; y++) for (var x = 0; x < 32; x++) {
    if (G[y][x]) continue;
    if ((y > 0 && G[y - 1][x]) || (y < 31 && G[y + 1][x]) || (x > 0 && G[y][x - 1]) || (x < 31 && G[y][x + 1])) out[y][x] = '#1a1512';
  }
  return out;
}
var gridCache = {};
function spriteGrid(look) {
  var key = JSON.stringify(look || {});
  if (gridCache[key]) return gridCache[key];
  var a = normalize(look); a.mouth = look && look.mouth; a.clipboard = look && look.clipboard;
  return (gridCache[key] = outline(build(a)));
}
function paint(ctx, look, ox, oy, u) {
  var G = spriteGrid(look);
  for (var y = 0; y < 32; y++) for (var x = 0; x < 32; x++) { if (!G[y][x]) continue; ctx.fillStyle = G[y][x]; ctx.fillRect(ox + x * u, oy + y * u, u, u); }
}
function drawTo(canvas, look) { var g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, canvas.height); paint(g, look, 0, 0, canvas.width / 32); }

// ════════════════════════════════════════════════════════════════════════
// The world: levels, streets, homeowners, the price book.
// ════════════════════════════════════════════════════════════════════════
var TITLES = ['Apprentice', 'Door Knocker', 'Inspector', 'Estimator', 'Closer', 'Storm Pro', 'Roof Boss', 'Legend'];
function levelFor(xp) {
  var L = 1; while (50 * L * (L + 1) <= xp) L++;
  return { level: L, floor: L === 1 ? 0 : 50 * (L - 1) * L, next: 50 * L * (L + 1), title: TITLES[Math.min(L - 1, TITLES.length - 1)] };
}
// Retail per square, from the NBD price book.
var TIERS = [
  { key: 'good', name: 'Good', psq: 550, note: 'Architectural shingle, 5-yr workmanship' },
  { key: 'better', name: 'Better', psq: 660, note: 'Upgraded shingle + synthetic underlayment' },
  { key: 'best', name: 'Best', psq: 770, note: 'Premium line + full system warranty' },
];
var BOSS = { maple: 'hoa', oak: 'lawyer', hollow: 'exadjuster', country: 'farmer', lakeview: 'ceo', oldtown: 'historic' };
var STREETS = [
  { id: 'maple', name: 'Maple Court', level: 1, ground: '#2d5a2a', yard: '#356b31', sq: [18, 28], hail: 0.75, traffic: 0.8, pool: ['nervous', 'skeptic', 'busy', 'elder', 'diy', 'firstHome', 'renter'], extras: ['nosolicit', 'empty'] },
  { id: 'oak', name: 'Oak Ridge', level: 3, ground: '#2f5f33', yard: '#3a7238', sq: [28, 40], hail: 0.6, traffic: 1.05, pool: ['threeQuotes', 'skeptic', 'deductible', 'landlord', 'busy', 'realtor', 'neighborPro', 'solar'], extras: ['nosolicit'] },
  { id: 'hollow', name: 'Storm Hollow', level: 5, ground: '#34502f', yard: '#3d5f36', sq: [22, 34], hail: 0.92, traffic: 1.3, pool: ['nervous', 'deductible', 'threeQuotes', 'landlord', 'diy', 'skeptic', 'veteran', 'caregiver'], extras: ['empty'] },
  { id: 'country', name: 'Country Road', level: 6, ground: '#4a6b2a', yard: '#5a7a34', sq: [24, 36], hail: 0.7, traffic: 0.6, pool: ['elder', 'diy', 'veteran', 'firstHome', 'caregiver', 'skeptic'], extras: ['empty'] },
  { id: 'lakeview', name: 'Lakeview Estates', level: 8, ground: '#2f6a4a', yard: '#3a7a54', sq: [40, 58], hail: 0.65, traffic: 1.0, pool: ['neighborPro', 'realtor', 'solar', 'threeQuotes', 'busy', 'skeptic'], extras: ['nightShift'] },
  { id: 'oldtown', name: 'Old Town', level: 10, ground: '#3c4f33', yard: '#4a5e3c', sq: [20, 30], hail: 0.8, traffic: 1.45, walls: ['#b5543c', '#9e4a36', '#c26a4a', '#a85a44', '#8f4632'], pool: ['elder', 'renter', 'landlord', 'caregiver', 'veteran', 'realtor'], extras: ['nightShift', 'nosolicit'] },
];
var NAMES = ['Linda', 'Mike', 'Tasha', 'Earl', 'Rosa', 'Dwayne', 'Priya', 'Gus', 'Carol', 'Marcus', 'Beth', 'Hank', 'Mei', 'Otis', 'Jada', 'Walt', 'Nora', 'Ray', 'Tina', 'Cal', 'Deb', 'Luis', 'Ada', 'Bo'];
var WALLS = ['#c9b79c', '#a9b7c6', '#d6c6a8', '#b8c9a9', '#e0cfa8', '#c4b5c9', '#d9b8a5', '#b5c4c9'];
var ROOFS = ['#5b4b3f', '#3d4450', '#6a4a3a', '#4a3f37', '#7a5a3a', '#45404d', '#565048'];
var PERSONA = {
  nervous: { want: 'better' }, skeptic: { want: 'best', mood: 'frown' }, busy: { want: 'better' },
  elder: { want: 'good', elder: true }, diy: { want: 'good' }, threeQuotes: { want: 'better' },
  deductible: { want: 'better' }, landlord: { want: 'good', mood: 'frown' },
  nosolicit: { want: 'better', mood: 'frown' }, empty: { want: 'better' },
  renter: { want: 'good' }, realtor: { want: 'good' }, firstHome: { want: 'good' }, nightShift: { want: 'better' },
  veteran: { want: 'best' }, neighborPro: { want: 'better', mood: 'frown' }, caregiver: { want: 'good', elder: true }, solar: { want: 'better' },
  farmer: { want: 'good', boss: true, tag: 'farmer', look: { skin: 3, hair: 'short', hairColor: 5, eyes: 'happy', hat: 'cap', hatColor: 3, beard: 'full', shirt: 1, vest: 'none', pants: 1, tool: 'none', extra: 'none' } },
  ceo: { want: 'best', boss: true, mood: 'frown', tag: 'CEO', look: { skin: 2, hair: 'ponytail', hairColor: 0, eyes: 'round', hat: 'none', hatColor: 0, beard: 'none', shirt: 5, vest: 'none', pants: 2, tool: 'none', extra: 'shades' } },
  historic: { want: 'best', boss: true, tag: 'Historic Commission chair', look: { skin: 0, hair: 'short', hairColor: 5, eyes: 'sleepy', hat: 'none', hatColor: 0, beard: 'mustache', shirt: 3, vest: 'none', pants: 1, tool: 'none', extra: 'glasses' } },
  hoa: { want: 'better', boss: true, mood: 'frown', tag: 'HOA president', look: { skin: 0, hair: 'long', hairColor: 5, eyes: 'round', hat: 'none', hatColor: 0, beard: 'none', shirt: 4, vest: 'none', pants: 3, tool: 'none', extra: 'glasses' } },
  lawyer: { want: 'best', boss: true, mood: 'frown', tag: 'attorney', look: { skin: 3, hair: 'short', hairColor: 0, eyes: 'round', hat: 'none', hatColor: 0, beard: 'stubble', shirt: 2, vest: 'none', pants: 2, tool: 'none', extra: 'glasses' } },
  exadjuster: { want: 'best', boss: true, tag: 'retired adjuster', look: { skin: 1, hair: 'bald', hairColor: 5, eyes: 'sleepy', hat: 'cap', hatColor: 1, beard: 'mustache', shirt: 5, vest: 'none', pants: 0, tool: 'none', extra: 'none', clipboard: true } },
};
var ADJUSTER = { skin: 2, hair: 'short', hairColor: 0, eyes: 'round', hat: 'cap', hatColor: 5, beard: 'mustache', shirt: 2, vest: 'none', pants: 2, tool: 'none', extra: 'glasses', clipboard: true };
var FOREMAN = { skin: 4, hair: 'buzz', hairColor: 0, eyes: 'happy', hat: 'hardhat', hatColor: 4, beard: 'full', shirt: 1, vest: 'yes', pants: 1, tool: 'tape', extra: 'glasses' };

// The talks. {n} is the homeowner's name. A choice: say, then go (next node) or end,
// trust (+/-), tip ({good|bad, text}), dirty (breaks the clean-day rule).
var TREES = {
  nervous: {
    start: { text: "Oh! Are you from my insurance? There's a dent in my gutter from last night and I'm a nervous wreck.", choices: [
      { say: "I'm with No Big Deal, a local roofer. I'm not your insurance. I'm checking roofs after the hail. Want me to take a free look?", go: 'calm', trust: 15 },
      { say: "Don't worry, I'll handle your insurance claim for you. I deal with adjusters all day.", end: 'lose', dirty: true, tip: { bad: true, text: "In Kentucky a contractor can't act for you on an insurance claim. Only you or a licensed public adjuster can. \"We'll handle your claim\" is the line to never use." } },
      { say: "Hail like that usually means a new roof. Let's get you signed up today.", go: 'pushy', trust: -20 },
    ] },
    calm: { text: "That would help. I don't even know what I'm looking for. What happens if there's damage?", choices: [
      { say: "I'll show you photos of anything I find. If it's real damage, you call your insurance and file the claim yourself. I can be there when the adjuster comes out.", go: 'yes', trust: 15, tip: { good: true, text: "The clean way: you show the evidence, they file, you can attend the adjuster meeting." } },
      { say: "If there's damage, I'll waive your deductible so it costs you nothing.", end: 'lose', dirty: true, tip: { bad: true, text: "Waiving or paying a deductible is insurance fraud, and Kentucky bans contractors from offering it. The deductible is the homeowner's to pay." } },
    ] },
    pushy: { text: "I just said I'm nervous. I'm not signing anything today.", choices: [
      { say: "Fair enough, that was too fast. Can I just take a free look and show you photos? No paperwork.", go: 'yes', trust: 10 },
      { say: "Okay. Here's my card.", end: 'later' },
    ] },
    yes: { text: "Okay. Go ahead, I'll make coffee.", choices: [{ say: "Thanks, {n}. Heading up now.", end: 'inspect' }] },
  },
  skeptic: {
    start: { text: "Let me guess. Storm chaser. I've had three of you guys here since breakfast.", choices: [
      { say: "I get it. I'm local, I'm on every roof myself, and you get photos whether you hire me or not.", go: 'proof', trust: 15 },
      { say: "I can beat any price those other guys gave you.", go: 'price', trust: -10 },
      { say: "Sorry to bother you, have a good one.", end: 'later' },
    ] },
    proof: { text: "Photos, huh. What's your warranty look like? The last guy got vague.", choices: [
      { say: "Workmanship warranty in writing, plus the manufacturer's. Both go on the estimate so you can compare.", go: 'look', trust: 15, tip: { good: true, text: "Skeptics buy proof. Specifics in writing beat a lower number." } },
      { say: "Lifetime warranty on everything, don't worry about it.", go: 'price', trust: -15, tip: { text: "\"Lifetime on everything\" sounds exactly like the vague guy. Be specific." } },
    ] },
    price: { text: "Everybody says that. I'm not doing this today.", choices: [
      { say: "Understood. My number's on the card if you change your mind.", end: 'later', trust: 5 },
    ] },
    look: { text: "Alright. Go look. If you find something, I want to see it.", choices: [{ say: "You'll see every photo.", end: 'inspect' }] },
  },
  busy: {
    start: { text: "I've got a baby asleep and a meeting in five minutes. What is it?", choices: [
      { say: "Thirty seconds: hail last night. I do free roof checks. Can I book a time that works for you?", go: 'book', trust: 15, tip: { good: true, text: "Busy people buy respect for their time. Short, then a clear next step." } },
      { say: "Let me tell you about shingle technology and why it matters for your family.", go: 'long', trust: -20 },
    ] },
    book: { text: "Tomorrow after four works. Text me before you come.", choices: [{ say: "Tomorrow after four. I'll text first. Thanks, {n}.", end: 'book' }] },
    long: { text: "I really don't have time for this.", choices: [
      { say: "Sorry. Can I just book a free check for tomorrow?", go: 'book', trust: 5 },
      { say: "I'll come back another day.", end: 'later' },
    ] },
  },
  elder: {
    start: { text: "Well hello there. You in the roofing business? That roof's older than my grandkids.", choices: [
      { say: "Yes, I am. How long have you been in the house?", go: 'story', trust: 20, tip: { good: true, text: "{n} wants to talk. Ask about them first, roof second." } },
      { say: "Your roof is shot. You need a new one.", go: 'blunt', trust: -15 },
    ] },
    story: { text: "Thirty-one years. Put that roof on myself in '03. No storm damage I know of, it's just tired. Curling on the back side.", choices: [
      { say: "That's a good run. Want me to climb up and show you the back? No charge.", go: 'ok', trust: 15 },
    ] },
    blunt: { text: "Hmph. I'll decide that, thank you.", choices: [
      { say: "You're right, I got ahead of myself. Can I take a look and show you what I see?", go: 'ok', trust: 10 },
      { say: "Have a good day.", end: 'later' },
    ] },
    ok: { text: "Go on up. Watch that second step on the ladder.", choices: [{ say: "Will do, {n}.", end: 'inspect' }] },
  },
  diy: {
    start: { text: "Saw the hail. I've got a ladder and a bundle of shingles in the garage. Figured I'd patch it myself.", choices: [
      { say: "Respect. Before you climb, want a free inspection so you know what you're patching? The photos are yours either way.", go: 'ok', trust: 15 },
      { say: "You'll void your warranty and fall off the roof. Leave it to the pros.", go: 'defensive', trust: -15 },
      { say: "Cool, good luck!", end: 'later' },
    ] },
    defensive: { text: "I've been on roofs longer than you've been alive.", choices: [
      { say: "Fair point. Can I at least take photos for your records? Free.", go: 'ok', trust: 5 },
      { say: "Okay, sorry to bother you.", end: 'later' },
    ] },
    ok: { text: "Huh. Photos can't hurt. Go ahead.", choices: [{ say: "Thanks, {n}.", end: 'inspect' }] },
  },
  threeQuotes: {
    start: { text: "I'm getting three quotes. You'd be number three. What makes you different?", choices: [
      { say: "Get all three. I'll walk you through mine line by line so you can compare apples to apples.", go: 'compare', trust: 15, tip: { good: true, text: "Shoppers want help comparing, not pressure." } },
      { say: "The other two guys are crooks. Don't trust them.", go: 'bash', trust: -20, tip: { text: "Bashing competitors makes you look like the crook." } },
      { say: "Whatever they quote, I'll go lower.", go: 'cheap', trust: -10 },
    ] },
    compare: { text: "Good. The last guy wrote one number on the back of a card.", choices: [
      { say: "Mine itemizes everything: tear-off, underlayment, flashing, vents. First I need to see the roof.", go: 'ok', trust: 10 },
    ] },
    bash: { text: "Huh. That's what the last guy said about you.", choices: [
      { say: "Fair. Let me just show you what I find and you decide.", go: 'ok', trust: 5 },
      { say: "Your loss.", end: 'lose' },
    ] },
    cheap: { text: "So you're padding your price, then?", choices: [
      { say: "No. I'd rather show you what's included and let you compare. Can I look at the roof?", go: 'ok', trust: 5 },
      { say: "Here's my card.", end: 'later' },
    ] },
    ok: { text: "Go ahead, I'll be in the garage.", choices: [{ say: "Thanks, {n}.", end: 'inspect' }] },
  },
  deductible: {
    start: { text: "Before you start: my buddy says roofers will cover your deductible. You do that?", choices: [
      { say: "No, I can't. In Kentucky that's illegal, and the deductible is your share. I can show you what the job looks like and options that fit your budget.", go: 'honest', trust: 20, tip: { good: true, text: "The straight answer wins trust, and it's the law." } },
      { say: "Sure, we'll eat the deductible. Just don't mention it to your insurance.", end: 'lose', dirty: true, tip: { bad: true, text: "Absorbing a deductible is insurance fraud and illegal for Kentucky contractors. Deal lost, and it should be." } },
      { say: "We can bump the estimate a little to cover it.", end: 'lose', dirty: true, tip: { bad: true, text: "Inflating an estimate to hide a deductible is insurance fraud." } },
    ] },
    honest: { text: "Huh. Most guys just say yes. I appreciate the straight answer.", choices: [
      { say: "Can I take a look at the roof? Free, with photos.", go: 'ok', trust: 10 },
    ] },
    ok: { text: "Sure, go on up.", choices: [{ say: "Thanks, {n}.", end: 'inspect' }] },
  },
  landlord: {
    start: { text: "I own this one and four others. I care about one thing: price.", choices: [
      { say: "Understood. Three options, real numbers, and you pick. Mind if I look first?", go: 'ok', trust: 15 },
      { say: "I can skip the permit and save you a few hundred.", end: 'lose', dirty: true, tip: { bad: true, text: "Skipping permits is cutting corners the owner pays for later. A pro never offers it." } },
      { say: "Cheap roofs cost more in the end.", go: 'lecture', trust: -10 },
    ] },
    lecture: { text: "Spare me the speech.", choices: [
      { say: "Fair. Three options, real numbers. Can I look?", go: 'ok', trust: 5 },
      { say: "Here's my card.", end: 'later' },
    ] },
    ok: { text: "Make it quick.", choices: [{ say: "Twenty minutes.", end: 'inspect' }] },
  },
  renter: {
    start: { text: "Oh, I just rent here. The owner lives in Florida.", choices: [
      { say: "Thanks for telling me. Could you pass along my card, or share the owner's number? Only the owner can approve roof work.", end: 'owner', trust: 10 },
      { say: "Just sign here and the owner can sort it out later.", end: 'lose', dirty: true, tip: { bad: true, text: "A tenant can't authorize work on someone else's house. That contract wouldn't be worth the paper." } },
      { say: 'Okay, have a good one.', end: 'later' },
    ] },
  },
  realtor: {
    start: { text: "I'm listing this house Friday. The buyer's inspector will flag the roof. Can you do something fast?", choices: [
      { say: "I'll inspect today and give you an honest written report. If it only needs a repair, I'll quote the repair, not a whole roof.", go: 'ok', trust: 20, tip: { good: true, text: 'Realtors send you deals for years if your reports are honest.' } },
      { say: "I'll write it up as storm damage so insurance pays before closing.", end: 'lose', dirty: true, tip: { bad: true, text: "Calling old wear storm damage is insurance fraud, no matter who's in a hurry." } },
    ] },
    ok: { text: 'Perfect. The lockbox code is on the door.', choices: [{ say: 'On it.', end: 'inspect' }] },
  },
  firstHome: {
    start: { text: "We just bought this place. Please don't tell us we need a new roof; we can't afford it.", choices: [
      { say: "Let's see what's actually wrong first. It might be a repair, or nothing. No pressure either way.", go: 'ok', trust: 20 },
      { say: 'Financing makes anything affordable! Sign today and lock it in.', go: 'scared', trust: -20 },
    ] },
    scared: { text: "That's... a lot. We need to think.", choices: [
      { say: "Fair. Let me just look and show you photos. You decide later, or never.", go: 'ok', trust: 10 },
      { say: "Here's my card.", end: 'later' },
    ] },
    ok: { text: 'Okay. Thank you for not being pushy.', choices: [{ say: 'Heading up.', end: 'inspect' }] },
  },
  nightShift: {
    start: { text: "(A sign on the door: NIGHT SHIFT WORKER SLEEPING. PLEASE DON'T KNOCK.)", choices: [
      { say: 'Leave a door hanger with a note to call when convenient. Walk away quietly.', end: 'hanger', tip: { good: true, text: 'Respecting their sleep earns a callback more often than a knock ever would.' } },
      { say: 'Knock anyway. It will only take a minute.', go: 'mad', trust: -40 },
    ] },
    mad: { text: "I worked twelve hours and you woke me up. Get off my porch.", choices: [{ say: 'Sorry.', end: 'lose', tip: { bad: true, text: 'Read the door before you knock.' } }] },
  },
  veteran: {
    start: { text: "Served twenty-two years. Don't sell me, son. Show me.", choices: [
      { say: 'Yes sir. Facts only: photos, a written report, and the options. Your call after that.', go: 'ok', trust: 25 },
      { say: 'Military discount if you sign today!', go: 'cold', trust: -15, tip: { text: 'A same-day deadline is pressure, even with a discount on it.' } },
    ] },
    cold: { text: "I don't do same-day anything.", choices: [
      { say: 'Understood. No deadline. Can I just show you what I find?', go: 'ok', trust: 10 },
      { say: "Here's my card.", end: 'later' },
    ] },
    ok: { text: 'Ladder is in the garage if you need a second one.', choices: [{ say: 'Thank you, sir.', end: 'inspect' }] },
  },
  neighborPro: {
    start: { text: "I'm a general contractor. I know roofs.", choices: [
      { say: "Then you'll want to see the photos. I'd value your eye on them.", go: 'ok', trust: 20, tip: { good: true, text: 'Experts want to be treated like experts. Invite them in.' } },
      { say: "With respect, you don't know roofs like I do.", go: 'prickly', trust: -20 },
    ] },
    prickly: { text: 'Is that right.', choices: [
      { say: "That came out wrong. Come up the ladder with me and judge for yourself.", go: 'ok', trust: 10 },
      { say: "Here's my card.", end: 'later' },
    ] },
    ok: { text: "Alright. Let's see what you've got.", choices: [{ say: "Let's go up.", end: 'inspect' }] },
  },
  caregiver: {
    start: { text: "I'm her daughter. Mom's 84 and I handle her paperwork. What's going on?", choices: [
      { say: "There was hail last night. I'd like to explain it to both of you, take your time, and nothing gets signed today.", go: 'ok', trust: 25, tip: { good: true, text: "With an elderly homeowner, slow down and include the family. That's ethics and good business." } },
      { say: 'Your mom can sign; she seemed to understand when I talked to her earlier.', end: 'lose', dirty: true, tip: { bad: true, text: 'Going around family to get an elderly homeowner to sign is pressure on a vulnerable adult. Never.' } },
    ] },
    ok: { text: 'Thank you. Mom, the nice roofer is going to look at the roof.', choices: [{ say: 'Back in twenty minutes.', end: 'inspect' }] },
  },
  solar: {
    start: { text: 'We have solar panels. Is that going to be a problem?', choices: [
      { say: "Not a problem, just a step: the panels come off and go back on with a licensed solar tech. It goes in the estimate so there are no surprises.", go: 'ok', trust: 20 },
      { say: "We'll just shingle around them.", go: 'ok', trust: -20, tip: { text: "Shingling around panels leaves old shingles under them to fail. Detach and reset, every time." } },
    ] },
    ok: { text: 'Good to know. Go ahead and look.', choices: [{ say: 'Heading up.', end: 'inspect' }] },
  },
  farmer: {
    start: { text: "Name's Dale. Out here we do business on a handshake. Cash price, no paperwork, no permit. Deal?", choices: [
      { say: "I'll shake your hand, Dale, and I'll still put it in writing with a permit. That protects you as much as me.", go: 'test', trust: 25 },
      { say: 'Cash, no permit. You got it.', end: 'lose', dirty: true, tip: { bad: true, text: 'No permit and no contract leaves the homeowner with nothing if anything goes wrong. A pro never offers it.' } },
    ] },
    test: { text: "Hmph. Barn's got a metal roof, house is shingle. You do both?", choices: [
      { say: "The house, yes. For the barn I'll refer you to a metal specialist I trust.", go: 'ok', trust: 20, tip: { good: true, text: "Knowing what you don't do is part of being trusted." } },
      { say: "Sure, metal's easy.", go: 'ok', trust: -15, tip: { text: "Metal is its own trade. Don't learn it on a customer's barn." } },
    ] },
    ok: { text: 'Fair enough. Go on up.', choices: [{ say: 'Thanks, Dale.', end: 'inspect' }] },
  },
  ceo: {
    start: { text: 'You have ninety seconds. What do I need to know?', choices: [
      { say: 'Likely hail damage. Free inspection now, a photo report in your inbox tonight, written options with prices. You decide on your time.', go: 'test', trust: 25 },
      { say: 'Let me start with a little about our company history and values...', go: 'test', trust: -20 },
    ] },
    test: { text: 'Can your crew finish in one day? I host clients Thursday.', choices: [
      { say: "If the weather holds, yes. I'll schedule around Thursday and confirm the day before.", go: 'ok', trust: 20 },
      { say: 'Guaranteed, rain or shine!', go: 'ok', trust: -15, tip: { text: 'Never promise the weather.' } },
    ] },
    ok: { text: 'Go. Report by tonight.', choices: [{ say: 'You will have it.', end: 'inspect' }] },
  },
  historic: {
    start: { text: 'Old Town is a historic district. Anything visible from the street needs Historic Commission approval.', choices: [
      { say: "Understood. I'll prepare the application with a matching profile and color and submit it before any work.", go: 'test', trust: 25 },
      { say: "It's just shingles. Nobody checks.", end: 'lose', tip: { bad: true, text: 'They check. Unapproved work in a historic district means fines and a tear-off at the owner\u2019s expense.' } },
    ] },
    test: { text: 'The original roof had copper flashing at the chimney.', choices: [
      { say: 'Then we match it: copper flashing, not aluminum.', go: 'ok', trust: 20 },
      { say: "Aluminum's cheaper and looks the same.", go: 'ok', trust: -20, tip: { text: "It doesn't look the same, and the Commission will say so." } },
    ] },
    ok: { text: 'Very well. You may inspect.', choices: [{ say: 'Thank you.', end: 'inspect' }] },
  },
  hoa: {
    start: { text: "I'm the HOA president. Nothing goes on a roof in this neighborhood without architectural approval. Did you know that?", choices: [
      { say: "Yes. I'll submit the HOA approval form with color samples and the spec sheet before any work starts.", go: 'colors', trust: 25, tip: { good: true, text: 'Bosses test whether you know the rules before they test your price.' } },
      { say: "HOAs can't stop storm repairs. We'll just start.", go: 'mad', trust: -30 },
    ] },
    colors: { text: "Good. Approved colors are Weathered Wood and Charcoal only. And what's your crew's cleanup plan?", choices: [
      { say: 'Tarps on the landscaping, a dumpster on the driveway, and a magnet sweep every single day.', go: 'ok', trust: 20 },
      { say: "They'll clean up at the end.", go: 'ok', trust: -10, tip: { text: 'Every day, not at the end. Neighbors walk their dogs past that driveway.' } },
    ] },
    mad: { text: "Then you'll be explaining that to our attorney.", choices: [
      { say: "You're right. I'll get the approval form in first.", go: 'colors', trust: 5 },
      { say: 'Good luck with that.', end: 'lose' },
    ] },
    ok: { text: "Fine. You may inspect. Do not step on my hydrangeas.", choices: [{ say: "I'll stay off the hydrangeas.", end: 'inspect' }] },
  },
  lawyer: {
    start: { text: 'Before you touch my roof: license, certificate of insurance, and a written contract. In that order.', choices: [
      { say: "Here's my certificate of insurance and our written contract. Read every line; I'll wait.", go: 'terms', trust: 25 },
      { say: "We're all friends here. You don't need all that paperwork.", go: 'cold', trust: -30 },
    ] },
    terms: { text: 'Any clause in here that lets you take my insurance money directly?', choices: [
      { say: 'No. No assignment of benefits and no money up front on an insurance job. You pay when the work is done.', go: 'ok', trust: 25, tip: { good: true, text: 'No AOB, no advance payment: exactly the Kentucky rules.' } },
      { say: 'Just the standard assignment of benefits, so I can deal with your insurer for you.', end: 'lose', dirty: true, tip: { bad: true, text: "Kentucky bans contractors from taking an assignment of benefits or dealing with the insurer for the homeowner. The attorney knew it." } },
    ] },
    cold: { text: "Then we're done here.", choices: [
      { say: "Fair. Here's my certificate of insurance and our contract to review.", go: 'terms', trust: 10 },
      { say: 'Your call.', end: 'later' },
    ] },
    ok: { text: "Acceptable. You may inspect. I'll be timing you.", choices: [{ say: 'Understood.', end: 'inspect' }] },
  },
  exadjuster: {
    start: { text: 'Thirty years as an insurance adjuster. I know every trick. Tell me how you would handle my claim.', choices: [
      { say: "I wouldn't. It's your claim. I document the damage, give you the photos and estimate, and you file it. I can be at the adjuster meeting if you want.", go: 'test', trust: 25, tip: { good: true, text: 'Right answer, and the only legal one in Kentucky.' } },
      { say: "I handle everything with the adjuster. You won't have to lift a finger.", end: 'lose', dirty: true, tip: { bad: true, text: "Handling the claim is public-adjuster work. A retired adjuster spots that line instantly, and so does the law." } },
    ] },
    test: { text: 'Good. Now tell me: what makes a hail hit a hail hit?', choices: [
      { say: 'A soft spot that gives under your thumb, granules knocked loose, and a random pattern, not a line.', go: 'ok', trust: 20, tip: { good: true, text: "That's how adjusters tell hail from blisters or foot traffic." } },
      { say: 'Any dark spot on a shingle counts.', go: 'ok', trust: -15, tip: { text: "Blisters and scuffs aren't hail. Pat would deny that in a heartbeat." } },
    ] },
    ok: { text: "Alright, kid. Show me what you find, and don't chalk anything that isn't hail.", choices: [{ say: 'Deal.', end: 'inspect' }] },
  },
  nosolicit: {
    start: { text: "(There's a NO SOLICITING sign on the door.)", choices: [
      { say: "Respect the sign. Leave a door hanger with your number and move on.", end: 'hanger', tip: { good: true, text: "Respecting the sign keeps your name clean on the street. The hanger still gets you seen." } },
      { say: "Knock anyway. Storm damage is important.", go: 'mad', trust: -30 },
    ] },
    mad: { text: "Can you not read? Off my porch.", choices: [{ say: "Sorry about that.", end: 'lose', tip: { bad: true, text: "Knocking past a No Soliciting sign costs you the house and your reputation on the street." } }] },
  },
};

// ── Training: three courses, each earns a badge with a perk on the job ──
var COURSES = {
  ladder: { name: 'Ladder safety', badge: 'Ladder certified', perk: '+3 seconds on every roof inspection (you set up faster)' },
  tools: { name: 'Right tool, right job', badge: 'Tool pro', perk: '+3 seconds on adjuster test squares' },
  law: { name: 'Kentucky rules', badge: 'Rules ready', perk: 'Boss doors start 10 trust warmer (they can tell you know the rules)' },
  anatomy: { name: 'Roof anatomy', badge: 'Roof reader', perk: 'Supplements: one missed item is pre-flagged' },
  measure: { name: 'Measuring', badge: 'Sharp pencil', perk: '+5 trust on every estimate (your numbers add up)' },
  walk: { name: 'Job walkthrough', badge: 'Job explainer', perk: '+5 trust on every pitch and follow-up (you can explain the job)' },
};
var LADDER_Q = [
  { q: 'How far should the ladder reach above the roof edge?', a: ['Even with the edge', 'About 3 feet above it', 'Just 6 inches above'], ok: 1, why: 'Three feet above the edge gives you something to hold stepping on and off.' },
  { q: 'Climbing, you keep…', a: ['Three points of contact', 'A bundle of shingles on one shoulder', 'One hand on your phone'], ok: 0, why: 'Two hands and a foot, or two feet and a hand, at all times. Haul materials up with a hoist or line.' },
  { q: 'Before raising an aluminum ladder, look up for…', a: ['Birds', 'Power lines', 'The HOA president'], ok: 1, why: 'Aluminum conducts. Keep at least 10 feet from power lines.' },
  { q: 'The ground at the base is soft and sloped. You…', a: ['Climb fast so it doesn\'t sink', 'Have the homeowner hold it', 'Set a firm, level base (levelers or a board)'], ok: 2, why: 'A firm, level footing first. Homeowners never hold your ladder.' },
  { q: 'Up at the top, the ladder should be…', a: ['Tied off or secured', 'Leaning on a gutter end cap', 'Loose, so it\'s easy to move'], ok: 0, why: 'Tie it off so it can\'t slide or kick out when you step on or off.' },
];
var TOOLS = ['Ladder', 'Chalk', 'Camera', 'Tape measure', 'Pry bar', 'Hammer', 'Roofing nails', 'Sealant', 'Pipe boot', 'Pressure washer', 'Paint roller', 'Leaf blower'];
var TOOL_WHY = { 'Pressure washer': 'Never on shingles: it strips the granules.', 'Paint roller': 'Paint has no place on a shingle roof.', 'Leaf blower': 'Not for this job.' };
var TOOL_JOBS = [
  { job: 'Hail inspection', need: ['Ladder', 'Chalk', 'Camera', 'Tape measure'], note: 'Chalk the hits, measure, and photograph everything.' },
  { job: 'Reseal a lifted shingle', need: ['Ladder', 'Sealant', 'Hammer', 'Roofing nails'], note: 'Seal it down and re-nail where the nails backed out.' },
  { job: 'Replace a cracked pipe boot', need: ['Ladder', 'Pry bar', 'Pipe boot', 'Hammer', 'Roofing nails', 'Sealant'], note: 'Pry up the shingles above, swap the boot, nail and seal.' },
];
var WALK_STEPS = [
  'Pull the permit and schedule delivery',
  'Protect the landscaping, set tarps',
  'Tear off the old roof',
  'Inspect the deck, replace soft wood',
  'Drip edge, ice & water shield, underlayment',
  'Starter strip, then shingles',
  'Flashing, vents and ridge cap',
  'Magnet sweep for nails, clean up',
  'Final walkthrough with the homeowner',
];

// ════════════════════════════════════════════════════════════════════════
// State. SAVE persists (end of each day, training, avatar changes). DAY is
// the day in progress; leaving mid-day replays that day from the morning.
// ════════════════════════════════════════════════════════════════════════
var KEY = 'roofrep.save.v2';
function rnd(n) { return Math.floor(Math.random() * n); }
function pick(a) { return a[rnd(a.length)]; }
function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function clock(m) { var h = Math.floor(m / 60), mm = m % 60; return (((h + 11) % 12) + 1) + ':' + (mm < 10 ? '0' : '') + mm + (h >= 12 ? ' PM' : ' AM'); }
function weekKey(d) { d = new Date(d || Date.now()); var day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function freshSave() {
  return { v: 2, day: 1, xp: 0, avatar: Object.assign({}, DEFAULTS), bestDay: 0, cleanDays: 0, sold: 0, collected: 0,
    weekKey: weekKey(), weekXp: 0, streetId: 'maple', streets: {}, agenda: [], nextId: 1, usedNames: [], badges: {}, trained: {}, bank: 0, skills: {}, owned: {}, seed: rnd(997) + 1, reviews: [], stats: {}, trophies: {}, seasons: {}, cleanStreak: 0 };
}
function migrate(s) {
  // Any field an older or partial save lacks gets today's default.
  var d = freshSave(); Object.keys(d).forEach(function (k) { if (s[k] == null) s[k] = d[k]; });
  if (!streetOf(s.streetId)) s.streetId = 'maple';
  s.badges = s.badges || {}; s.trained = s.trained || {}; s.usedNames = s.usedNames || []; s.skills = s.skills || {}; s.reviews = s.reviews || []; s.stats = s.stats || {}; s.trophies = s.trophies || {}; s.seasons = s.seasons || {}; s.cleanStreak = s.cleanStreak || 0; s.owned = s.owned || {}; if (s.bank == null) s.bank = s.collected || 0; s.seed = s.seed || 1 + Math.floor(Math.random() * 997); return s; }
function makeLook(persona) {
  var p = PERSONA[persona] || {};
  return { skin: rnd(6), hair: p.elder ? pick(['bald', 'short']) : pick(['short', 'long', 'buzz', 'ponytail', 'bald', 'short', 'long']),
    hairColor: p.elder ? 5 : rnd(5), eyes: pick(['round', 'round', 'happy', 'sleepy']), hat: p.elder && Math.random() < .5 ? 'cap' : 'none',
    hatColor: rnd(5), beard: Math.random() < .25 ? pick(['stubble', 'mustache', 'full']) : 'none', shirt: rnd(6), vest: 'none', pants: rnd(4),
    tool: 'none', extra: Math.random() < .25 ? 'glasses' : 'none', mouth: p.mood || '' };
}
function newName() {
  var free = NAMES.filter(function (n) { return SAVE.usedNames.indexOf(n) < 0; });
  if (!free.length) { SAVE.usedNames = []; free = NAMES.slice(); }
  var n = pick(free); SAVE.usedNames.push(n); return n;
}
function rollDamage(street, persona) {
  if (PERSONA[persona] && PERSONA[persona].elder) return 'old';
  if (PERSONA[persona] && PERSONA[persona].boss) return 'hail';
  var se = seasonFor(SAVE.day), small = se === 'fall' || se === 'winter' ? 0.32 : 0.12;
  if (Math.random() < small) return se === 'fall' ? (Math.random() < .75 ? 'gutter' : 'repair') : se === 'winter' ? (Math.random() < .75 ? 'repair' : 'gutter') : pick(['gutter', 'repair']);
  if (Math.random() < street.hail) return Math.random() < .78 ? 'hail' : 'some';
  return Math.random() < .5 ? 'old' : 'none';
}
function makeHouse(street, i, persona) {
  return { i: i, x: [16, 120, 224][i % 3], top: i < 3, wall: pick(street.walls || WALLS), roof: pick(ROOFS), persona: persona,
    name: persona === 'empty' ? 'Nobody home' : persona === 'nosolicit' ? 'Homeowner' : newName(), look: makeLook(persona),
    dog: Math.random() < 0.25 && persona !== 'empty', damage: rollDamage(street, persona), sq: street.sq[0] + rnd(street.sq[1] - street.sq[0] + 1), status: 'fresh', since: SAVE.day, trust: 30 };
}
function streetOf(id) { return STREETS.filter(function (s) { return s.id === id; })[0]; }
function ensureStreet(id) {
  if (!SAVE.streets[id]) {
    var st = streetOf(id);
    var personas = shuffle(shuffle(st.pool).slice(0, 6 - st.extras.length).concat(st.extras));
    SAVE.streets[id] = { houses: personas.map(function (p, i) { return makeHouse(st, i, p); }) };
  }
  var S2 = SAVE.streets[id];
  if (!S2.boss) {
    var cand = S2.houses.filter(function (h) { return h.status === 'fresh' && h.persona !== 'empty' && h.persona !== 'nosolicit' && h.persona !== 'nightShift' && h.persona !== 'renter'; });
    if (cand.length) {
      var bh = pick(cand), bp = BOSS[id];
      bh.persona = bp; bh.look = Object.assign({ mouth: PERSONA[bp].mood || '' }, PERSONA[bp].look); bh.tag = PERSONA[bp].tag; bh.trust = 10; bh.sq += 10; bh.damage = 'hail';
      S2.boss = bp;
    }
  }
  return S2;
}
function houseAt(sid, i) { return ensureStreet(sid).houses[i]; }
function lvl() { return levelFor(SAVE.xp).level; }

var SAVE = null, DAY = null;
var WALK = { px: 160, py: 100, path: [], target: null, busy: false };
var ROAD_Y = 92;

// ── Saving: localStorage always; the artifact's db when it's available ──
function saveLocal() { try { localStorage.setItem(KEY, JSON.stringify(SAVE)); } catch (_) {} }
function loadLocal() { try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && s.v === 2 ? migrate(s) : null; } catch (_) { return null; } }
// Saves: localStorage first (instant boot), then Firestore when signed in to
// NBD Pro. js/pages/roof-rep-net.js sets window.RoofRepNet (or null when signed
// out) and fires 'roofrep:net'. The career lives on roofRep/{uid}; the crew
// board reads roofRepScores for the caller's company only (firestore.rules).
var NET = { net: null, uid: null, scores: [] };
function persist() {
  saveLocal();
  if (!NET.net) return;
  NET.net.save(JSON.parse(JSON.stringify(SAVE)));
  pushScore();
}
function pushScore() {
  if (!NET.net) return;
  var L = levelFor(SAVE.xp);
  NET.net.pushScore({ xp: SAVE.xp, level: L.level, title: L.title, weekKey: SAVE.weekKey, weekXp: SAVE.weekXp, bestDay: SAVE.bestDay,
    days: SAVE.day - 1, cleanDays: SAVE.cleanDays, collected: SAVE.collected, badges: Object.keys(SAVE.badges).length, avatar: normalize(SAVE.avatar) });
}
function waitNet() {
  return new Promise(function (resolve) {
    if (window.RoofRepNet !== undefined) return resolve(window.RoofRepNet);
    window.addEventListener('roofrep:net', function () { resolve(window.RoofRepNet || null); }, { once: true });
  });
}
async function connect() {
  var net = await waitNet();
  if (!net) { renderCrew(); return; }
  NET.net = net; NET.uid = net.uid;
  try {
    var remote = await net.loadSave();
    var otherRep = SAVE.uid && SAVE.uid !== net.uid;
    if (!DAY && remote && remote.v === 2 && (otherRep || remote.day > SAVE.day || (remote.day === SAVE.day && remote.xp >= SAVE.xp))) SAVE = migrate(remote);
    else if (!DAY && otherRep) SAVE = freshSave();
    if (!SAVE.avatarFromCrm && net.avatar && SAVE.day === 1 && SAVE.xp === 0) { SAVE.avatar = normalize(net.avatar); SAVE.avatarFromCrm = true; }
    SAVE.uid = net.uid; ensureStreet(SAVE.streetId); saveLocal(); renderAll();
    if (!remote || remote.day < SAVE.day || (remote.day === SAVE.day && remote.xp < SAVE.xp)) persist();
  } catch (e) { console.warn('[roof-rep] load failed', e && e.code); }
  net.watchScores(function (rows) { NET.scores = rows; renderCrew(); });
}

// ── Skills, upgrades, weather, supplements ──
var SKILLS = {
  rapport: { name: 'Rapport', what: '+4 trust at every door you knock, per rank.' },
  eagle: { name: 'Eagle eye', what: '+2 seconds on every roof inspection, per rank.' },
  hustle: { name: 'Hustle', what: 'Walk faster; each knock takes 2 fewer minutes, per rank.' },
  closer: { name: 'Closer', what: 'Estimates get a yes a little easier, per rank.' },
  safety: { name: 'Safety', what: 'Slips cost 25% less time, per rank.' },
  networker: { name: 'Networker', what: 'Referral calls come more often, per rank.' },
  paper: { name: 'Paperwork pro', what: 'Each rank pre-flags one missed line item on a scope sheet.' },
};
function slipMin() { return Math.round((owns('harness') ? 20 : 60) * (1 - 0.25 * sk('safety'))); }
function sk(k) { return (SAVE.skills && SAVE.skills[k]) || 0; }
function spFree() { return lvl() - 1 - Object.keys(SAVE.skills).reduce(function (a, k) { return a + SAVE.skills[k]; }, 0); }
var SHOP = [
  { id: 'hangers', name: 'Premium door hangers', price: 800, what: 'Hanger doors reopen after 1 day instead of 2, and warmer.' },
  { id: 'signs', name: 'Yard signs', price: 1500, what: 'Every finished roof warms up two neighbors instead of one.' },
  { id: 'ipad', name: 'iPad estimates', price: 2500, what: 'Clean, itemized estimates on the spot: +5 trust on every pitch.' },
  { id: 'truck', name: 'Truck: backup cam + lift kit', price: 4000, what: 'Town traffic feels 20% slower on every drive.' },
  { id: 'drone', name: 'Inspection drone', price: 6000, what: 'Damage blinks for the first 2 seconds of every inspection, and wind doesn\'t slow you down.' },
  { id: 'treats', name: 'Dog treats', price: 200, what: 'Keep a bag in the truck. Barking dogs become your biggest fans (+12 trust).' },
  { id: 'meter', name: 'Moisture meter', price: 2000, what: 'Finds the real leak: repair calls narrow to two options.' },
  { id: 'harness', name: 'Harness and rope system', price: 3000, what: 'Wind no longer cuts inspections, and a slip costs 20 minutes, not an hour.' },
  { id: 'wrap', name: 'Branded truck wrap', price: 5000, what: 'People know you before you knock: +3 trust at every door.' },
  { id: 'canvasser', name: 'Hire a canvasser', price: 8000, what: 'Books one inspection for you every morning.' },
  { id: 'office', name: 'Hire an office manager', price: 10000, what: 'Schedules waiting builds each morning and keeps the CRM log for you.' },
  { id: 'crew2', name: 'Second crew', price: 12000, what: 'Build two roofs a day instead of one.' },
];
function owns(id) { return !!(SAVE.owned && SAVE.owned[id]); }
// Weather is fixed per day for a career (seeded), so the forecast never lies.
function weatherFor(day) {
  if (day <= 1) return 'sun';
  var x = Math.sin((day + 1) * 12.9898 + (SAVE.seed || 1) * 78.233) * 43758.5453; x = x - Math.floor(x);
  var w = x < 0.17 ? 'rain' : x < 0.34 ? 'wind' : 'sun';
  return w === 'rain' && seasonFor(day) === 'winter' ? 'snow' : w;
}
function wet(w) { return w === 'rain' || w === 'snow'; }
var WX = { sun: { icon: '☀', name: 'Clear' }, wind: { icon: '🌬', name: 'Windy' }, rain: { icon: '🌧', name: 'Rain' }, snow: { icon: '🌨', name: 'Snow' } };
// Supplements: line items an adjuster's scope can miss, and padding a pro never adds.
var SUPP_ITEMS = [
  { k: 'drip', name: 'Drip edge', amt: 420, why: 'Required by code on eaves and rakes.' },
  { k: 'starter', name: 'Starter strip', amt: 310, why: 'Needed on every eave and rake so the first course seals.' },
  { k: 'iws', name: 'Ice & water shield', amt: 680, why: 'Code in valleys and at the eaves.' },
  { k: 'ridge', name: 'Ridge cap', amt: 380, why: 'Ridge cap is its own line item, not field shingles.' },
  { k: 'boots', name: 'Pipe boots', amt: 160, why: 'Old boots don\'t survive a tear-off.' },
  { k: 'step', name: 'Step flashing', amt: 290, why: 'Walls and chimneys get new step flashing.' },
  { k: 'permit', name: 'Permit fee', amt: 150, why: 'The permit is a real cost of the job.' },
  { k: 'dump', name: 'Dumpster and debris haul', amt: 450, why: 'The tear-off has to go somewhere.' },
];
var SUPP_PAD = ['Gutter guards (gutters weren\'t damaged)', 'Upgrade to the Best shingle line', 'A second layer that isn\'t there'];

// ════════════════════════════════════════════════════════════════════════
// Days: morning (builds land, storms roll in, old doors reopen), the day,
// the summary.
// ════════════════════════════════════════════════════════════════════════
function stormStreet(day) {
  if (day < 4 || day % 4) return null;
  var open = STREETS.filter(function (s) { return lvl() >= s.level; });
  return open[(day / 4) % open.length];
}
function reopens(h) {
  var age = SAVE.day - h.since;
  return (h.status === 'later' && age >= 2) || (h.status === 'hanger' && age >= (owns('hangers') ? 1 : 2)) || (h.status === 'lost' && age >= 5) ||
    ((h.status === 'fine' || h.status === 'quiet' || h.status === 'denied' || h.status === 'rivaled') && age >= 6);
}
function morningPlan() {
  var plan = { party: SAVE.day % 7 === 6, short: supplyShort(SAVE.day), cat: SAVE.day >= 10 && SAVE.day % 10 === 0, builds: [], waiting: [], small: [], unsched: 0, reopen: 0, season: seasonFor(SAVE.day), newSeason: SAVE.day > 1 && (SAVE.day - 1) % 7 === 0, storm: stormStreet(SAVE.day), wx: weatherFor(SAVE.day) };
  var due = [];
  Object.keys(SAVE.streets).forEach(function (sid) {
    SAVE.streets[sid].houses.forEach(function (h) {
      if (h.status === 'approved' && h.buildDay != null && h.buildDay <= SAVE.day) (h.small ? plan.small : due).push({ sid: sid, h: h });
      else if (h.status === 'approved' && h.buildDay == null && SAVE.day - h.since >= 2) plan.unsched++;
      else if (reopens(h)) plan.reopen++;
    });
  });
  due.sort(function (a, b) { return a.h.buildDay - b.h.buildDay; });
  var cap = crewCap(SAVE.day);
  plan.builds = due.slice(0, cap); plan.waiting = due.slice(cap);
  return plan;
}
function applyMorning(plan) {
  plan.small.forEach(function (b) { completeBuild(b.h, b.sid, 0, null); });
  if (owns('office')) unscheduled().forEach(function (x) {
    for (var d = SAVE.day + 1; d < SAVE.day + 8; d++) if (crewCap(d) > jobsOn(d).length && x.h.noDay !== d) { x.h.buildDay = d; break; }
  });
  if (owns('canvasser')) {
    var lead = shuffle(allHouses().filter(function (x) { return x.h.status === 'fresh' && lvl() >= streetOf(x.sid).level && x.h.persona !== 'empty' && x.h.persona !== 'nosolicit' && x.h.persona !== 'nightShift' && x.h.persona !== 'renter' && (x.h.damage === 'hail' || x.h.damage === 'some'); }))[0];
    if (lead) { setStatus(lead.h, 'booked'); lead.h.trust = Math.max(lead.h.trust, 55); addAgenda('inspect', lead.sid, lead.h.i, SAVE.day); DAY.canvassed = lead.h.name; }
  }
  if (plan.storm) { SAVE.lastStorm = SAVE.lastStorm || {}; SAVE.lastStorm[plan.storm.id] = SAVE.day; }
  DAY.rivalLost = 0;
  if (plan.party) ensureStreet(SAVE.streetId).houses.forEach(function (h) { if (h.status === 'fresh') h.trust = Math.min(100, h.trust + 10); });
  if (plan.cat) {
    stat('cat');
    SAVE.lastStorm = SAVE.lastStorm || {}; SAVE.lastCat = SAVE.day;
    STREETS.forEach(function (x) { if (lvl() >= x.level) { ensureStreet(x.id); SAVE.lastStorm[x.id] = SAVE.day; } });
    allHouses().forEach(function (x) { if (x.h.status === 'fresh' && !PERSONA[x.h.persona].elder) x.h.damage = Math.random() < .9 ? 'hail' : 'some'; });
  }
  allHouses().forEach(function (x) {
    var h = x.h;
    if (h.status === 'fresh' && h.rival && !h.rivalBeat && SAVE.day - h.rival >= 1) { if (Math.random() < 0.5) { setStatus(h, 'rivaled'); DAY.rivalLost++; } h.rival = null; }
    if (h.status === 'approved' && h.buildDay == null && SAVE.day - h.since >= 3) h.trust = Math.max(0, h.trust - 5);
    if (plan.newSeason && h.status === 'fresh' && !PERSONA[h.persona].elder && !PERSONA[h.persona].boss) h.damage = rollDamage(streetOf(x.sid), h.persona);
  });
  RIVAL.x = 340; RIVAL.tx = 340;
  plan.builds.forEach(function (b) {
    setStatus(b.h, 'building'); addAgenda('build', b.sid, b.h.i, SAVE.day);
  });
  plan.waiting.forEach(function (b) { b.h.buildDay = SAVE.day + 1; });
  Object.keys(SAVE.streets).forEach(function (sid) {
    SAVE.streets[sid].houses.forEach(function (h) {
      if (reopens(h)) { h.trust = h.status === 'lost' ? 20 : h.status === 'hanger' && owns('hangers') ? 60 : 45; h.status = 'fresh'; h.since = SAVE.day; h.remembers = true; }
      if (plan.storm && plan.storm.id === sid && h.status === 'fresh') h.damage = Math.random() < .85 ? 'hail' : 'some';
    });
  });
}
function startDay() {
  var plan = morningPlan();
  DAY = { min: 9 * 60, end: 18 * 60, xp: 0, insp: 0, signed: 0, sold: 0, collected: 0, clean: true, log: [], over: false, wx: plan.wx, calls: 0 };
  if (SAVE.weekKey !== weekKey()) { SAVE.weekKey = weekKey(); SAVE.weekXp = 0; }
  applyMorning(plan);
  WALK = { px: 160, py: 100, path: [], target: null, busy: false };
  renderAll(); showTab('street'); var wxTip = wet(plan.wx) ? 'Rain today: roofs are wet, so no climbing. Book inspections for tomorrow and work the phone.' : plan.wx === 'wind' ? 'Windy today: ladders are touchy' + (SAVE.badges.ladder || owns('drone') ? ', but your training has you covered.' : '. Inspections run 4 seconds shorter without the ladder badge.') : '';
  var chs = CHALLENGES.filter(function (c) { return !c.when || c.when(); }); var ch = pick(chs); DAY.ch = { k: ch.k, need: ch.need, text: ch.text }; DAY.counts = {};
  SAVE.seasons = SAVE.seasons || {}; SAVE.seasons[seasonFor(SAVE.day)] = 1; checkTrophies();
  wxTip = 'Today\'s challenge: ' + ch.text + ' (+40 XP). ' + wxTip;
  if (DAY.canvassed) wxTip = 'Your canvasser booked ' + DAY.canvassed + ' for today. ' + wxTip;
  if (DAY.rivalLost) wxTip = 'Storm Bros signed ' + DAY.rivalLost + ' door' + (DAY.rivalLost > 1 ? 's' : '') + ' you left hanging. Get to rival-visited doors fast. ' + wxTip;
  idle(plan.builds.length ? { good: true, text: 'Build day! The crew is on ' + plan.builds.map(function (b) { return b.h.name; }).join(' and ') + (plan.builds.length > 1 ? "'s roofs" : "'s roof") + '. Run the build from your Today list, or they finish by 6 PM without you. ' + wxTip } : plan.waiting.length && wet(plan.wx) ? { text: 'Rain pushed ' + plan.waiting.length + ' build' + (plan.waiting.length > 1 ? 's' : '') + ' to tomorrow. ' + wxTip } : wxTip ? { text: wxTip } : null);
  if (SAVE.lastCat && SAVE.day - SAVE.lastCat === 1) setTimeout(newsCrew, 900);
}
function spend(m) { if (!DAY || DAY.over) return; DAY.min += m; hud(); if (DAY.min >= DAY.end) endDay(); }
function levelToast(before) {
  var after = levelFor(SAVE.xp);
  if (after.level <= before) return;
  var unl = STREETS.filter(function (s) { return s.level === after.level; }).map(function (s) { return s.name; });
  var gear = Object.keys(LOCKS).filter(function (k) { return LOCKS[k] === after.level; });
  sfx('level');
  toast('LEVEL UP! ' + after.level + ' · ' + after.title.toUpperCase() + (unl.length ? ' · NEW STREET: ' + unl.join(', ').toUpperCase() : '') + (gear.length ? ' · NEW GEAR IN THE LOCKER' : ''));
  renderChips(); renderLocker(); hud();
}
function gain(x, why) {
  var before = lvl();
  DAY.xp += x; SAVE.xp += x; DAY.log.push({ xp: x, why: why }); hud();
  levelToast(before);
}
// XP outside a working day (training before you clock in).
function gainAny(x, why) {
  if (DAY) return gain(x, why);
  if (SAVE.weekKey !== weekKey()) { SAVE.weekKey = weekKey(); SAVE.weekXp = 0; }
  var before = lvl(); SAVE.xp += x; SAVE.weekXp += x; hud(); levelToast(before); persist();
}
function endDay() {
  if (!DAY || DAY.over) return;
  WALK.path = []; WALK.busy = false;
  agendaDue(SAVE.day).filter(function (a) { return a.type === 'build'; }).forEach(function (a) { completeBuild(houseAt(a.sid, a.i), a.sid, 0); });
  DAY.over = true;
  crmLog(finishDay);
}
function finishDay() {
  if (DAY.clean && DAY.xp > 0) { gain(50, 'Clean day: no shady promises'); SAVE.cleanDays++; SAVE.cleanStreak = (SAVE.cleanStreak || 0) + 1; } else SAVE.cleanStreak = 0;
  checkTrophies();
  SAVE.weekXp += DAY.xp; SAVE.bestDay = Math.max(SAVE.bestDay, DAY.xp); SAVE.sold += DAY.sold;
  var done = DAY, dayNo = SAVE.day;
  SAVE.day++; DAY = null;
  persist();
  var L = levelFor(SAVE.xp), ag = agendaDue(SAVE.day).length;
  var rank = done.xp >= 300 ? 'Roof Boss day' : done.xp >= 180 ? 'Closer day' : done.xp >= 90 ? 'Solid day' : 'Rookie day';
  overlay('<h2>DAY ' + dayNo + ' DONE · ' + rank.toUpperCase() + '</h2><div class="grid-sum">' +
    '<span>XP earned</span><b>' + done.xp + '</b><span>Inspections</span><b>' + done.insp + '</b><span>Contracts signed</span><b>' + done.signed + '</b>' +
    '<span>Sold (retail)</span><b>' + money(done.sold) + '</b><span>Collected</span><b>' + money(done.collected) + '</b>' +
    '<span>Clean day</span><b>' + (done.clean ? 'Yes' : 'No') + '</b><span>Level</span><b>' + L.level + ' · ' + esc(L.title) + '</b></div>' +
    '<ul class="report">' + done.log.slice(-7).map(function (l) { return '<li>+' + l.xp + ' · ' + esc(l.why) + '</li>'; }).join('') + '</ul>' +
    '<p class="help">Sold isn\'t collected: the money comes in when the roof is built. ' + (ag ? 'Tomorrow you have ' + ag + ' thing' + (ag > 1 ? 's' : '') + ' on your list.' : '') + '</p>' +
    '<button type="button" class="btn primary wide" id="nextDay">On to day ' + SAVE.day + '</button>');
  document.getElementById('nextDay').addEventListener('click', function () { closeOverlay(); renderAll(); showTab('today'); });
  renderAll();
}

// ── The agenda (things you said you'd do) ──
var AG_MIN = { inspect: 45, followup: 10, adjuster: 60, supplement: 20, build: 90 };
function agendaDue(day) { return SAVE.agenda.filter(function (a) { return a.due <= day; }); }
function addAgenda(type, sid, i, due, extra) { SAVE.agenda.push(Object.assign({ id: SAVE.nextId++, type: type, sid: sid, i: i, due: due }, extra || {})); }
function dropAgenda(id) { SAVE.agenda = SAVE.agenda.filter(function (a) { return a.id !== id; }); }
function agendaLabel(a) {
  var h = houseAt(a.sid, a.i), st = streetOf(a.sid).name;
  if (a.type === 'inspect') return { t: 'Inspection at ' + h.name + "'s", s: st + ' · booked appointment' };
  if (a.type === 'followup') return { t: 'Follow up with ' + h.name + ' on the estimate', s: st + ' · ' + (a.tries ? 'second try' : 'they have your estimate') };
  if (a.type === 'build') return { t: 'Build day at ' + h.name + "'s", s: st + ' · the crew is on the roof; run the build or they finish by 6 PM' };
  if (a.type === 'supplement') return { t: 'Supplement packet for ' + h.name, s: st + " · Pat's scope sheet is in; find what's missing before the build" };
  return { t: 'Adjuster meeting at ' + h.name + "'s", s: st + ' · ' + h.name + ' filed the claim; you show your photos' };
}

// ════════════════════════════════════════════════════════════════════════
// The street.
// ════════════════════════════════════════════════════════════════════════
var W = document.getElementById('world'), g = W.getContext('2d');
function curStreet() { return streetOf(SAVE.streetId); }
function doorOf(h) { return { x: h.x + 40, y: h.top ? 74 : 122 }; }
var FLAG = { rivaled: '#7f4fb0', building: '#d8743a', booked: '#8ec5ff', inspected: '#8ec5ff', signed: '#7bc96f', approved: '#7bc96f', built: '#f3ede2', hanger: '#f2a900', later: '#a9b0bf', lost: '#ef6b6b', fine: '#7bc96f', denied: '#ef6b6b', quiet: '#a9b0bf' };
function drawHouse(h, st) {
  var y = h.top ? 18 : 122, w = 80;
  g.fillStyle = seasonFor(SAVE.day) === 'winter' ? '#dfe7ea' : seasonFor(SAVE.day) === 'fall' ? '#5f7a34' : st.yard; g.fillRect(h.x - 4, h.top ? 8 : 116, w + 8, 76);
  if (st.id === 'oak') { g.fillStyle = '#e8e2d4'; for (var fx = h.x - 2; fx < h.x + 84; fx += 6) g.fillRect(fx, h.top ? 10 : 186, 2, 6); g.fillRect(h.x - 2, h.top ? 12 : 188, 86, 1); }
  var roofC = h.status === 'built' ? '#3f4a5a' : h.roof;
  g.fillStyle = h.wall; g.fillRect(h.x + 6, y + 22, w - 12, 34);
  g.fillStyle = shade(h.wall, -25); g.fillRect(h.x + 6, y + 52, w - 12, 4);
  for (var i = 0; i < 12; i++) { g.fillStyle = i % 3 === 0 ? shade(roofC, 12) : roofC; g.fillRect(h.x + i * 2, y + 22 - i * 2, w - i * 4, 2); }
  g.fillStyle = shade(roofC, -25); g.fillRect(h.x, y + 22, w, 2);
  if (h.status !== 'built') {
    if (h.damage === 'hail') { g.fillStyle = '#1b1b1b'; [[18, 12], [30, 16], [46, 10], [58, 15], [38, 6]].forEach(function (p) { g.fillRect(h.x + p[0], y + p[1], 2, 2); }); }
    if (h.damage === 'some') { g.fillStyle = '#1b1b1b'; [[24, 14], [50, 12]].forEach(function (p) { g.fillRect(h.x + p[0], y + p[1], 2, 2); }); }
    if (h.damage === 'gutter') { g.fillStyle = '#9aa0a6'; g.fillRect(h.x + 2, y + 24, 30, 2); g.fillRect(h.x + 32, y + 26, 14, 2); g.fillRect(h.x + 46, y + 24, 32, 2); if (seasonFor(SAVE.day) === 'fall') { g.fillStyle = '#e0b45a'; g.fillRect(h.x + 10, y + 23, 3, 1); g.fillRect(h.x + 56, y + 23, 4, 1); } }
    if (h.damage === 'repair') { g.fillStyle = '#1b1b1b'; g.fillRect(h.x + 52, y + 9, 3, 3); g.fillStyle = '#9aa0a6'; g.fillRect(h.x + 52, y + 4, 2, 4); }
    if (PERSONA[h.persona].boss && h.status === 'fresh') { g.fillStyle = '#f2a900'; g.fillRect(h.x + 34, y - 8, 12, 4); g.fillRect(h.x + 34, y - 11, 2, 3); g.fillRect(h.x + 39, y - 12, 2, 4); g.fillRect(h.x + 44, y - 11, 2, 3); }
    if (h.damage === 'old') { g.fillStyle = shade(h.roof, 30); for (var j = 0; j < 6; j++) g.fillRect(h.x + 12 + j * 9, y + 14 + (j % 2) * 3, 5, 1); }
  } else { g.fillStyle = '#f2a900'; g.fillRect(h.x + 30, y + 4, 20, 1); }
  g.fillStyle = '#8ec5ff'; g.fillRect(h.x + 14, y + 30, 12, 10); g.fillRect(h.x + w - 26, y + 30, 12, 10);
  g.fillStyle = '#2b3442'; g.fillRect(h.x + 19, y + 30, 2, 10); g.fillRect(h.x + w - 21, y + 30, 2, 10);
  g.fillStyle = '#6b3a24'; g.fillRect(h.x + 35, y + 38, 10, 18); g.fillStyle = '#f2a900'; g.fillRect(h.x + 43, y + 47, 1, 2);
  if (h.persona === 'nosolicit' || h.persona === 'nightShift') { g.fillStyle = '#fff'; g.fillRect(h.x + 47, y + 40, 10, 6); g.fillStyle = '#c0392b'; g.fillRect(h.x + 48, y + 42, 8, 2); }
  if (h.status === 'built') { g.fillStyle = '#d8743a'; g.fillRect(h.x + 62, y + 44, 10, 7); g.fillStyle = '#fff'; g.fillRect(h.x + 64, y + 46, 6, 1); g.fillRect(h.x + 64, y + 48, 4, 1); g.fillStyle = '#5a3a22'; g.fillRect(h.x + 66, y + 51, 2, 5); }
  g.fillStyle = '#b9b0a0'; g.fillRect(h.x + 36, h.top ? y + 56 : y - 14, 8, 14);
  if (h.dog) { var dx2 = h.x + 58, dy2 = h.top ? y + 60 : y - 10; g.fillStyle = '#1a1512'; g.fillRect(dx2 - 1, dy2 - 1, 10, 6); g.fillStyle = '#a0612b'; g.fillRect(dx2, dy2, 8, 4); g.fillRect(dx2 + 6, dy2 - 2, 3, 3); g.fillStyle = '#1a1512'; g.fillRect(dx2 + 8, dy2 - 1, 1, 1); g.fillStyle = '#a0612b'; g.fillRect(dx2, dy2 + 4, 1, 2); g.fillRect(dx2 + 6, dy2 + 4, 1, 2); g.fillRect(dx2 - 2, dy2 - 1, 2, 1); }
  var c = FLAG[h.status];
  if (c) { g.fillStyle = '#1a1512'; g.fillRect(h.x + 69, h.top ? y + 1 : y + 59, 8, 8); g.fillStyle = c; g.fillRect(h.x + 70, h.top ? y + 2 : y + 60, 6, 6); }
  if (SAVE.agenda.some(function (a) { return a.sid === st.id && a.i === h.i && a.due <= SAVE.day; })) { g.fillStyle = '#f2a900'; g.fillRect(h.x + 38, y - 6, 4, 8); g.fillRect(h.x + 38, y + 4, 4, 3); }
}
function drawTruck(c, x, y, s) {
  // Top-down pickup, nose up: white body, ladder rack, orange stripe.
  s = s || 1;
  c.fillStyle = '#1a1512'; c.fillRect(x - 1 * s, y - 1 * s, 14 * s, 22 * s);
  c.fillStyle = '#f3ede2'; c.fillRect(x, y, 12 * s, 20 * s);
  c.fillStyle = '#8ec5ff'; c.fillRect(x + 2 * s, y + 3 * s, 8 * s, 3 * s);
  c.fillStyle = '#d8743a'; c.fillRect(x, y + 8 * s, 12 * s, 1 * s);
  c.fillStyle = '#9aa0a6'; c.fillRect(x + 1 * s, y + 10 * s, 1 * s, 9 * s); c.fillRect(x + 10 * s, y + 10 * s, 1 * s, 9 * s);
  for (var r = 11; r < 19; r += 3) c.fillRect(x + 1 * s, y + r * s, 10 * s, 1 * s);
  c.fillStyle = '#2a2320'; c.fillRect(x - 1 * s, y + 3 * s, 1 * s, 3 * s); c.fillRect(x + 12 * s, y + 3 * s, 1 * s, 3 * s); c.fillRect(x - 1 * s, y + 14 * s, 1 * s, 3 * s); c.fillRect(x + 12 * s, y + 14 * s, 1 * s, 3 * s);
}
function drawWorld() {
  var st = curStreet();
  g.fillStyle = seasonFor(SAVE.day) === 'winter' ? '#c9d3d6' : st.ground; g.fillRect(0, 0, 320, 200);
  g.fillStyle = '#c9c1b2'; g.fillRect(0, 80, 320, 8); g.fillRect(0, 112, 320, 8);
  g.fillStyle = '#3b3f47'; g.fillRect(0, 88, 320, 24);
  g.fillStyle = '#e8d27a'; for (var x = 4; x < 320; x += 20) g.fillRect(x, 99, 10, 2);
  if (st.id === 'hollow') { g.fillStyle = '#56606e'; [[40, 104], [180, 92], [260, 106]].forEach(function (p) { g.fillRect(p[0], p[1], 14, 3); }); g.fillStyle = '#5a3a22'; [[96, 84], [210, 116]].forEach(function (p) { g.fillRect(p[0], p[1], 12, 2); g.fillRect(p[0] + 4, p[1] - 2, 2, 2); }); }
  g.save(); g.translate(14, 110); g.rotate(-Math.PI / 2); drawTruck(g, 0, 0, 1); g.restore();
  ensureStreet(st.id).houses.forEach(function (h) { drawHouse(h, st); });
  var SE = SEASON[seasonFor(SAVE.day)];
  [[104, 60], [208, 60], [104, 150], [208, 150]].forEach(function (t) { g.fillStyle = '#5a3a22'; g.fillRect(t[0], t[1] + 8, 3, 8); g.fillStyle = SE.tree; g.fillRect(t[0] - 4, t[1], 11, 9); g.fillStyle = SE.leaf; g.fillRect(t[0] - 2, t[1] + 1, 5, 4); });
  if (DAY && rivalStreet(st.id)) {
    var rdx = RIVAL.tx - RIVAL.x, rdy = RIVAL.ty - RIVAL.y, rd = Math.hypot(rdx, rdy);
    if (rd > 1.6) { RIVAL.x += rdx / rd * 1.6; RIVAL.y += rdy / rd * 1.6; }
    paint(g, RIVAL_LOOK, Math.round(RIVAL.x) - 8, Math.round(RIVAL.y) - 30, 0.5);
    g.fillStyle = '#e24b4a'; g.fillRect(Math.round(RIVAL.x) - 4, Math.round(RIVAL.y) - 36, 8, 4);
  }
  paint(g, SAVE.avatar, Math.round(WALK.px) - 8, Math.round(WALK.py) - 30, 0.5);
}
function walkTo(h) {
  if (!DAY || WALK.busy || !document.getElementById('ov').hidden) return;
  var d = doorOf(h);
  WALK.target = h; WALK.busy = true;
  WALK.path = [{ x: WALK.px, y: ROAD_Y + 8 }, { x: d.x, y: ROAD_Y + 8 }, { x: d.x, y: d.y }];
}
function tick() {
  if (WALK.path.length) {
    var p = WALK.path[0], dx = p.x - WALK.px, dy = p.y - WALK.py, dist = Math.hypot(dx, dy), sp = 2.4 + 0.5 * sk('hustle');
    if (dist <= sp) { WALK.px = p.x; WALK.py = p.y; WALK.path.shift(); if (!WALK.path.length) arrive(); }
    else { WALK.px += dx / dist * sp; WALK.py += dy / dist * sp; }
  }
  if (!document.getElementById('p-street').hidden) drawWorld();
  requestAnimationFrame(tick);
}
var STATUS_MSG = {
  later: "{n} has your card. Give it a couple of days.", hanger: "Your door hanger is still on the knob. Try again in a couple of days.",
  lost: "{n} isn't interested. That door is closed for now.", booked: "You're booked here. It's on your Today list.",
  inspected: "{n} has your estimate. Follow up from your Today list.", signed: "{n} signed! The adjuster meeting is on your list.",
  approved: "Approved. Check the crew board on your Today list.", rivaled: "{n} signed with Storm Bros. Their phone number's already disconnected.", building: "The crew is on {n}'s roof today. Run it from your Today list.", built: "{n}'s new roof looks great. They're telling the neighbors.",
  fine: "You told {n} the roof was fine. They remember that.", denied: "The claim was denied. {n} is thinking it over.", quiet: "{n} went quiet. Maybe next storm.",
};
function arrive() {
  var h = WALK.target; WALK.busy = false;
  spend(Math.max(2, 5 + rnd(4) - 2 * sk('hustle'))); if (!DAY || DAY.over) return;
  sfx('knock');
  if (h.status === 'fresh') dayCount('knock');
  if (h.dog && h.status === 'fresh' && h.dogDay !== SAVE.day) {
    sfx('bark');
    return say(null, 'A big dog', 'WOOF! A big dog is barking behind the gate, and the latch looks loose.', [
      { say: 'Stay outside the gate and wave the homeowner to the door.', act: function () { h.dogDay = SAVE.day; spend(3); if (!DAY || DAY.over) return; h.trust = Math.min(100, h.trust + 5); stat('dogs'); arrive2(h, { good: true, text: 'Smart. Never walk into a yard with a loose dog. The owner appreciated you waiting.' }); } },
      owns('treats') ? { say: 'Toss a treat from the truck stash and wait for the owner.', act: function () { h.dogDay = SAVE.day; spend(3); if (!DAY || DAY.over) return; h.trust = Math.min(100, h.trust + 12); stat('dogs'); arrive2(h, { good: true, text: 'Best friends now. Dog people love a rep who loves dogs.' }); } } : null,
      { say: 'Open the gate and walk up. Dogs love me.', act: function () { h.dogDay = SAVE.day; spend(20); if (!DAY || DAY.over) return; h.trust = Math.max(0, h.trust - 15); arrive2(h, { bad: true, text: 'This one did not love you. Twenty minutes to get your pant leg back. Wait at the gate, always.' }); } },
    ].filter(Boolean));
  }
  arrive2(h, null);
}
function arrive2(h, dogTip) {
  if (h.status !== 'fresh') { say(h.persona === 'empty' ? null : h.look, h.name, (STATUS_MSG[h.status] || 'Nothing to do here today.').replace(/\{n\}/g, h.name), []); return; }
  if (h.persona === 'empty') {
    say(null, 'Nobody home', 'No answer. There are ' + (h.damage === 'hail' || h.damage === 'some' ? 'hail marks on the gutters, though.' : 'leaves in the gutters, at least.'), [
      { say: 'Leave a door hanger with your number', act: function () { setStatus(h, 'hanger'); gain(5, 'Door hanger left'); idle(); } },
      { say: 'Walk away', act: function () { idle(); } },
    ]);
    return;
  }
  var tip = dogTip || (h.referral ? { good: true, text: h.referral + ' told ' + h.name + ' about you. Warm door.' } : h.remembers ? { text: h.name + ' remembers you from last time.' } : null);
  if (h.rival && !h.rivalBeat && h.status === 'fresh') { if (h.rapDay !== SAVE.day) { h.trust = Math.min(100, h.trust + 4 * sk('rapport')); h.rapDay = SAVE.day; } return rivalTalk(h, tip); }
  if (h.rapDay !== SAVE.day) { h.trust = Math.min(100, h.trust + (PERSONA[h.persona].boss && SAVE.badges.law ? 10 : 0) + (owns('wrap') ? 3 : 0) + 4 * sk('rapport') + (repStars() >= 4.5 && SAVE.reviews.length >= 2 ? 5 : 0)); h.rapDay = SAVE.day; }
  node(h, 'start', tip);
}

// ── Dialogue ──
var faceCv = document.getElementById('face');
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function say(look, name, text, choices, tip) {
  faceCv.getContext('2d').clearRect(0, 0, 32, 32);
  if (look) drawTo(faceCv, look);
  var t = document.getElementById('talk'); t.innerHTML = '';
  var n = document.createElement('div'); n.className = 'who'; n.textContent = name; t.appendChild(n);
  var p = document.createElement('p'); p.className = 'line'; p.textContent = text; t.appendChild(p);
  if (tip && tip.text) { var d = document.createElement('div'); d.className = 'tip' + (tip.bad ? ' bad' : tip.good ? ' good' : ''); d.textContent = tip.text; t.appendChild(d); }
  var c = document.createElement('div'); c.className = 'choices';
  choices.forEach(function (ch) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = ch.say;
    b.addEventListener('click', function () { if (!document.getElementById('ov').hidden || b.dataset.used) return; b.dataset.used = '1'; ch.act(); });
    c.appendChild(b);
  });
  t.appendChild(c);
}
function idle(tip) {
  if (!DAY) { say(null, curStreet().name, 'Start your day from the Today tab.', [{ say: 'Go to Today', act: function () { showTab('today'); } }]); return; }
  var due = agendaDue(SAVE.day).length;
  rivalMove();
  maybeRing();
  say(null, curStreet().name, (WX[DAY.wx] ? WX[DAY.wx].icon + ' ' : '') + 'Pick a door.' + (due ? ' You also have ' + due + ' thing' + (due > 1 ? 's' : '') + ' on your Today list.' : ''), due ? [{ say: 'Open my Today list', act: function () { showTab('today'); } }] : [], tip);
}
function fill(s, h) { return String(s).replace(/\{n\}/g, h.name); }
function node(h, key, tip) {
  var nd = TREES[h.persona][key];
  say(h.look, h.name + (h.tag ? ' · ' + h.tag : ''), fill(nd.text, h), nd.choices.map(function (ch) {
    return { say: fill(ch.say, h), act: function () {
      h.trust = Math.max(0, Math.min(100, h.trust + (ch.trust || 0)));
      if (ch.dirty) DAY.clean = false;
      spend(4); if (!DAY || DAY.over) return;
      var t2 = ch.tip ? { good: ch.tip.good, bad: ch.tip.bad, text: fill(ch.tip.text, h) } : null;
      if (ch.go) return node(h, ch.go, t2);
      finish(h, ch.end, t2);
    } };
  }), tip);
}
function setStatus(h, s) { h.status = s; h.since = SAVE.day; if (DAY && !DAY.over) { DAY.events = DAY.events || {}; DAY.events[h.name + h.i + h.persona] = { h: h }; } }
function finish(h, end, tip) {
  if (end === 'lose') { setStatus(h, 'lost'); idle(tip || { bad: true, text: 'That one is gone.' }); return; }
  if (end === 'owner') { setStatus(h, 'later'); gain(10, "Got the owner's number from " + h.name); idle({ good: true, text: "Owners sign contracts, not tenants. You've got the owner's number to call." }); return; }
  if (end === 'later') { setStatus(h, 'later'); gain(2, 'Left a card with ' + h.name); idle(tip); return; }
  if (end === 'hanger') { setStatus(h, 'hanger'); gain(5, 'Door hanger, sign respected'); idle(tip); return; }
  if (end === 'book') { setStatus(h, 'booked'); h.trust = Math.max(h.trust, 55); addAgenda('inspect', SAVE.streetId, h.i, SAVE.day + 1); gain(25, 'Booked an inspection with ' + h.name); idle(tip || { good: true, text: "It's on tomorrow's list." }); return; }
  if (end === 'inspect') inspect(h, SAVE.streetId);
}

// ════════════════════════════════════════════════════════════════════════
// Minigames.
// ════════════════════════════════════════════════════════════════════════
// Tap the damage before the clock runs out.
function gridGame(o, done) {
  var cols = o.cols, rows = o.rows, cell = o.cell, spots = [], found = [], left = o.seconds, over = false;
  while (spots.length < o.n) { var k = rnd(cols * rows); if (spots.indexOf(k) < 0) spots.push(k); }
  overlay('<h2>' + esc(o.title) + '</h2><p class="help">' + esc(o.help) + '</p>' +
    '<canvas class="mg" id="mg" width="' + cols * cell + '" height="' + rows * cell + '" aria-label="Roof: tap the damage"></canvas>' +
    '<div class="row"><b id="mgT">' + left + 's</b><span class="help grow" id="mgF">Found 0</span><button type="button" class="btn" id="mgDone">Done</button></div>');
  var cv = document.getElementById('mg'), r = cv.getContext('2d'), revealUntil = o.reveal ? Date.now() + 2000 : 0;
  if (o.reveal) setTimeout(function () { if (!over) paintGrid(); }, 2050);
  function paintGrid() {
    var reveal = Date.now() < revealUntil;
    for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) {
      var i = y * cols + x;
      r.fillStyle = (x + y) % 2 ? shade(o.roof, 8) : o.roof; r.fillRect(x * cell, y * cell, cell, cell);
      r.fillStyle = shade(o.roof, -20); r.fillRect(x * cell, y * cell + cell - 2, cell, 2);
      if (spots.indexOf(i) >= 0) {
        if (o.style === 'bag') { r.fillStyle = '#1a1512'; r.fillRect(x * cell + 5, y * cell + 9, cell - 10, cell - 18); r.fillStyle = '#c9a66b'; r.fillRect(x * cell + 6, y * cell + 10, cell - 12, cell - 20); }
        else if (o.style === 'nail') { r.fillStyle = '#c9ccd1'; r.fillRect(x * cell + cell / 2 - 1, y * cell + 6, 2, cell - 12); r.fillRect(x * cell + cell / 2 - 3, y * cell + 6, 6, 2); }
        else if (o.style === 'old') { r.fillStyle = shade(o.roof, 26); r.fillRect(x * cell + 3, y * cell + 4, cell - 6, 3); }
        else { r.fillStyle = shade(o.roof, -14); var s = Math.max(3, Math.round(cell / 5)); r.fillRect(x * cell + (cell - s) / 2, y * cell + (cell - s) / 2 - 1, s, s); }
      }
      if (reveal && spots.indexOf(i) >= 0 && found.indexOf(i) < 0) { r.strokeStyle = '#8ec5ff'; r.lineWidth = 2; r.strokeRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4); }
      if (found.indexOf(i) >= 0) { r.strokeStyle = o.chalk ? '#ffffff' : '#f2a900'; r.lineWidth = 2; r.beginPath(); r.arc(x * cell + cell / 2, y * cell + cell / 2 - 1, cell / 2 - 3, 0, Math.PI * 2); r.stroke(); }
    }
    if (o.square) { r.strokeStyle = '#ffffff'; r.lineWidth = 2; r.setLineDash([4, 3]); r.strokeRect(1, 1, cols * cell - 2, rows * cell - 2); r.setLineDash([]); }
  }
  paintGrid();
  cv.addEventListener('click', function (e) {
    if (over) return;
    var b = cv.getBoundingClientRect(), x = Math.floor((e.clientX - b.left) / b.width * cols), y = Math.floor((e.clientY - b.top) / b.height * rows), i = y * cols + x;
    if (spots.indexOf(i) >= 0 && found.indexOf(i) < 0) {
      found.push(i); paintGrid();
      document.getElementById('mgF').textContent = 'Found ' + found.length;
      if (found.length === o.n) end();
    }
  });
  document.getElementById('mgDone').addEventListener('click', end);
  var timer = setInterval(function () { left--; var el = document.getElementById('mgT'); if (el) el.textContent = left + 's'; if (left <= 0) end(); }, 1000);
  function end() { if (over) return; over = true; clearInterval(timer); closeOverlay(); done(found.length, o.n); }
}

// Drive across town: Frogger with a pickup truck.
var ROW = 28, DROWS = 8;
function drive(dest, done) {
  var lanes = [], sp = dest.traffic * (owns('truck') ? 0.8 : 1), carCols = ['#e24b4a', '#378add', '#639922', '#7f4fb0', '#f2c200', '#5f5e5a', '#d85a30'];
  // rows 1-3 and 5-6 are road, 4 is a median, 0 is the destination, 7 the lot you leave from.
  [[1, -1, 1.5, 3, 30], [2, 1, 1.0, 3, 26], [3, -1, 1.9, 2, 44], [5, 1, 1.3, 3, 28], [6, -1, 0.9, 4, 26]].forEach(function (L) {
    var cars = [], gap = 320 / L[3];
    for (var k = 0; k < L[3]; k++) cars.push({ x: k * gap + rnd(Math.max(1, gap - L[4] - 30)), w: L[4], c: pick(carCols), bus: L[4] > 40 });
    lanes.push({ row: L[0], dir: L[1], v: L[2] * sp, cars: cars });
  });
  var T = { x: 154, row: 7, bumps: 0, flash: 0 }, left = 30, over = false, raf = 0;
  overlay('<h2>DRIVE TO ' + esc(dest.name.toUpperCase()) + '</h2><p class="help">Get the truck across town. Move up a lane at a time and dodge traffic. Every bump costs you 10 minutes.</p>' +
    '<canvas class="mg" id="dv" width="320" height="' + ROW * DROWS + '" aria-label="Town traffic: drive the truck to the top"></canvas>' +
    '<div class="dpad"><button type="button" class="btn u" data-dv="u" aria-label="Up">▲</button><button type="button" class="btn l" data-dv="l" aria-label="Left">◀</button><button type="button" class="btn d" data-dv="d" aria-label="Down">▼</button><button type="button" class="btn r" data-dv="r" aria-label="Right">▶</button></div>' +
    '<div class="row"><span class="help grow" id="dvS">Bumps: 0</span><b id="dvT">30s</b></div>');
  var cv = document.getElementById('dv'), c = cv.getContext('2d');
  function move(k) {
    if (over) return;
    if (k === 'u') T.row--; else if (k === 'd') T.row = Math.min(DROWS - 1, T.row + 1);
    else if (k === 'l') T.x = Math.max(4, T.x - 22); else if (k === 'r') T.x = Math.min(304, T.x + 22);
    if (T.row <= 0) finish(false);
  }
  document.querySelectorAll('[data-dv]').forEach(function (b) { b.addEventListener('click', function () { move(b.dataset.dv); }); });
  cv.addEventListener('click', function (e) {
    var b = cv.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * 320, y = (e.clientY - b.top) / b.height * ROW * DROWS;
    var ty = T.row * ROW;
    if (y < ty) move('u'); else if (y > ty + ROW) move('d'); else move(x < T.x ? 'l' : 'r');
  });
  function key(e) { var m = { ArrowUp: 'u', ArrowDown: 'd', ArrowLeft: 'l', ArrowRight: 'r', w: 'u', s: 'd', a: 'l', d: 'r' }[e.key]; if (m) { e.preventDefault(); move(m); } }
  document.addEventListener('keydown', key);
  var timer = setInterval(function () { left--; var el = document.getElementById('dvT'); if (el) el.textContent = left + 's'; if (left <= 0) finish(true); }, 1000);
  function frame() {
    if (over) return;
    lanes.forEach(function (L) { L.cars.forEach(function (car) { car.x += L.dir * L.v; if (L.dir > 0 && car.x > 330) car.x = -car.w - rnd(30); if (L.dir < 0 && car.x < -car.w - 10) car.x = 330 + rnd(30); }); });
    var lane = lanes.filter(function (L) { return L.row === T.row; })[0];
    if (lane && T.flash <= 0 && lane.cars.some(function (car) { return T.x + 12 > car.x + 2 && T.x < car.x + car.w - 2; })) {
      T.bumps++; T.flash = 40; T.row = DROWS - 1; T.x = 154; sfx('bump');
      var s = document.getElementById('dvS'); if (s) s.textContent = 'Bumps: ' + T.bumps + ' · fender bender! +10 min';
    }
    if (T.flash > 0) T.flash--;
    // draw
    for (var r = 0; r < DROWS; r++) {
      var y = r * ROW;
      if (r === 0) { c.fillStyle = dest.ground; c.fillRect(0, y, 320, ROW); c.fillStyle = '#e8e2d4'; c.fillRect(120, y + 4, 80, 16); c.fillStyle = '#185fa5'; c.fillRect(122, y + 6, 76, 12); c.fillStyle = '#fff'; c.font = '7px "Press Start 2P", monospace'; c.textAlign = 'center'; c.fillText(dest.name.toUpperCase(), 160, y + 15); c.fillStyle = '#5a3a22'; c.fillRect(158, y + 20, 4, 8); }
      else if (r === 4) { c.fillStyle = '#356b31'; c.fillRect(0, y, 320, ROW); c.fillStyle = '#2f7a35'; for (var bx = 10; bx < 320; bx += 52) c.fillRect(bx, y + 9, 10, 9); }
      else if (r === DROWS - 1) { c.fillStyle = '#6b6f78'; c.fillRect(0, y, 320, ROW); c.fillStyle = '#e8e2d4'; for (var px = 20; px < 320; px += 40) c.fillRect(px, y + 2, 2, ROW - 4); }
      else { c.fillStyle = '#3b3f47'; c.fillRect(0, y, 320, ROW); if (r !== 3 && r !== 6) { c.fillStyle = '#e8d27a'; for (var dx = 4; dx < 320; dx += 20) c.fillRect(dx, y + ROW - 1, 10, 2); } }
    }
    lanes.forEach(function (L) { L.cars.forEach(function (car) {
      var y = L.row * ROW + 6;
      c.fillStyle = '#1a1512'; c.fillRect(car.x - 1, y - 1, car.w + 2, 18);
      c.fillStyle = car.bus ? '#f2c200' : car.c; c.fillRect(car.x, y, car.w, 16);
      c.fillStyle = '#8ec5ff';
      if (car.bus) { for (var wx = 4; wx < car.w - 4; wx += 7) c.fillRect(car.x + wx, y + 3, 4, 4); }
      else c.fillRect(L.dir > 0 ? car.x + car.w - 9 : car.x + 3, y + 3, 6, 10);
    }); });
    if (!(T.flash > 0 && Math.floor(T.flash / 5) % 2)) drawTruck(c, T.x, T.row * ROW + 4, 1);
    raf = requestAnimationFrame(frame);
  }
  frame();
  function finish(timeout) {
    if (over) return; over = true; clearInterval(timer); cancelAnimationFrame(raf); document.removeEventListener('keydown', key);
    closeOverlay(); done(T.bumps, timeout);
  }
}
function goToStreet(st, then) {
  if (st.id === SAVE.streetId) { if (then) then(); return; }
  if (!DAY) { SAVE.streetId = st.id; ensureStreet(st.id); renderChips(); if (then) then(); else idle(); return; }
  drive(st, function (bumps, timeout) {
    var mins = 15 + bumps * 10 + (timeout ? 15 : 0);
    SAVE.streetId = st.id; ensureStreet(st.id); WALK.px = 30; WALK.py = 100; WALK.path = [];
    renderChips(); spend(mins); if (!DAY || DAY.over) return;
    if (!bumps && !timeout) { gain(5, 'Clean drive to ' + st.name); stat('drives'); }
    var tip = { good: !bumps && !timeout, text: 'Drove to ' + st.name + ' in ' + mins + ' min' + (bumps ? ' (' + bumps + ' fender bender' + (bumps > 1 ? 's' : '') + ')' : ', not a scratch') + '.' };
    if (then) then(tip); else idle(tip);
  });
}
var SPOTS = { hail: 7, some: 4, old: 5, none: 0, gutter: 4, repair: 2 };
function inspect(h, sid) {
  if (wet(DAY.wx)) {
    return say(h.look, h.name, "It's coming down out there. You sure you want to go up?", [
      { say: 'No. Wet shingles are ice. Book it for tomorrow.', act: function () {
        setStatus(h, 'booked'); h.trust = Math.max(h.trust, 55); addAgenda('inspect', sid, h.i, SAVE.day + 1); gain(15, 'Safe call: booked ' + h.name + ' for a dry day');
        idle({ good: true, text: 'Never climb a wet roof. ' + h.name + ' respects that, and it\'s on tomorrow\'s list.' });
      } },
      { say: 'Climb anyway. Time is money.', act: function () {
        spend(slipMin()); if (!DAY || DAY.over) return; setStatus(h, 'booked'); addAgenda('inspect', sid, h.i, SAVE.day + 1);
        idle({ bad: true, text: 'You slipped on the first course and slid to the gutter. You\'re okay, but you lost an hour and scared ' + h.name + '. Never climb a wet roof.' });
      } },
    ]);
  }
  if (seasonFor(SAVE.day) === 'winter' && DAY.min < 11 * 60) {
    var wait = 11 * 60 - DAY.min;
    return say(h.look, h.name, "There's still frost on the shingles.", [
      { say: 'Wait for the frost to burn off, then go up (' + wait + ' min).', act: function () { spend(wait); if (!DAY || DAY.over) return; gain(10, 'Waited out the frost'); inspect(h, sid); } },
      { say: 'Go up now. It looks fine.', act: function () { spend(slipMin()); if (!DAY || DAY.over) return; setStatus(h, 'booked'); addAgenda('inspect', sid, h.i, SAVE.day + 1); idle({ bad: true, text: 'Frost is as slick as ice. You slid, lost an hour, and rebooked for tomorrow. Wait for it to burn off.' }); } },
    ]);
  }
  var windCut = DAY.wx === 'wind' && !SAVE.badges.ladder && !owns('drone') && !owns('harness') ? 4 : 0;
  gridGame({ title: h.damage === 'old' ? 'Find the worn shingles' : h.damage === 'gutter' ? 'Check the gutters' : h.damage === 'repair' ? 'Find the leak' : 'Find the damage', help: 'Tap every damaged spot you see. Photos of real damage are what close the deal, and nothing else counts.',
    cols: 10, rows: 6, cell: 20, n: SPOTS[h.damage], seconds: 15 + (SAVE.badges.ladder ? 3 : 0) + 2 * sk('eagle') - windCut, reveal: owns('drone'), roof: h.roof, style: h.damage === 'old' || h.damage === 'gutter' ? 'old' : 'hail' },
  function (found, n) {
    spend(30); if (!DAY || DAY.over) return;
    DAY.insp++; dayCount('insp'); h.found = n ? found / n : 0;
    gain(20 + found * 3, 'Inspected ' + h.name + "'s roof: " + found + ' photo' + (found === 1 ? '' : 's'));
    if (h.damage === 'gutter' || h.damage === 'repair') return pitchSmall(h, sid);
    if (h.damage === 'none') return honesty(h, sid);
    if (found) return photoReport(h, function () { pitch(h, sid); });
    pitch(h, sid);
  });
}
function honesty(h, sid) {
  say(h.look, h.name, "So? How bad is it?", [
    { say: "Good news: your roof is in good shape. No storm damage. Call me if that changes.", act: function () {
      setStatus(h, 'fine'); gain(30, 'Honest call at ' + h.name + "'s"); stat('honest');
      var warm = ensureStreet(sid).houses.filter(function (x) { return x.status === 'fresh' && x !== h && x.persona !== 'empty'; });
      if (warm.length) { var w = pick(warm); w.trust += 20; w.referral = h.name; }
      idle({ good: true, text: 'No damage, no sale, and that\'s the right call. ' + h.name + ' will tell the neighbors you\'re honest.' });
    } },
    { say: "Point at some granule loss and tell them it needs replacing.", act: function () {
      DAY.clean = false; setStatus(h, 'lost');
      idle({ bad: true, text: 'Selling a roof that doesn\'t need it is how roofers lose their name. ' + h.name + ' got a second opinion.' });
    } },
  ]);
}
function pitch(h, sid) { if (h.measured) return pitchTiers(h, sid); return measureStep(h, sid); }
function pitchTiers(h, sid, mTip) {
  var lead = h.damage === 'old' ? 'You show ' + h.name + ' the worn shingles. They nod slowly.' :
    h.found >= 0.7 ? 'Your photos show clear hail hits. ' + h.name + ' leans in.' : 'You only got a few photos. ' + h.name + ' looks unsure.';
  say(h.look, h.name, lead + ' (' + h.sq + ' squares.) Which option do you recommend?', TIERS.map(function (t) {
    return { say: t.name + ' · ' + money(t.psq * h.sq) + ' · ' + t.note, act: function () { decide(h, sid, t); } };
  }).concat([{ say: 'Leave the estimate and let them think it over', act: function () {
    setStatus(h, 'inspected'); addAgenda('followup', sid, h.i, SAVE.day + 1, { tries: 0 }); gain(5, 'Estimate left with ' + h.name);
    idle({ text: 'Estimate left. Their follow-up is on tomorrow\'s list.' });
  } }]), mTip || (SAVE.badges.walk ? { good: true, text: 'Job explainer badge: you walk them through the whole job, start to finish (+5 trust).' } : null));
}
function tierScore(h, t) {
  var order = ['good', 'better', 'best'], d = Math.abs(order.indexOf(t.key) - order.indexOf(PERSONA[h.persona].want));
  return d === 0 ? 25 : d === 1 ? 0 : -25;
}
function signed(h, sid, t) {
  var price = t.psq * h.sq;
  h.price = price; h.tier = t.key; DAY.signed++; DAY.sold += price; dayCount('sign'); sfx('cash');
  if (PERSONA[h.persona].boss) stat('bosses');
  gain(60 + Math.round(price / 1000), h.name + ' signed: ' + t.name + ' ' + money(price));
  if (h.damage === 'hail' || h.damage === 'some') {
    if (PERSONA[h.persona].boss) gain(100, 'Boss door beaten: the ' + h.tag);
    setStatus(h, 'signed'); addAgenda('adjuster', sid, h.i, SAVE.day + 1);
    return { good: true, text: h.name + ' signed the ' + t.name + ' option. Insurance job: ' + h.name + ' files the claim and pays the deductible. The adjuster meeting is on tomorrow\'s list.' };
  }
  setStatus(h, 'approved'); newApproval(h);
  if (PERSONA[h.persona].boss) gain(100, 'Boss door beaten: the ' + h.tag);
  return { good: true, text: h.name + ' signed the ' + t.name + ' option. Retail job: pick a build day on the crew board, and you collect when it\'s done.' };
}
function decide(h, sid, t) {
  spend(15); if (!DAY || DAY.over) return;
  var score = h.trust + (SAVE.badges.walk ? 5 : 0) + (SAVE.badges.measure ? 5 : 0) + (owns('ipad') ? 5 : 0) + (h.found || 0) * 40 + tierScore(h, t) + rnd(15) - 7;
  if (score >= 75 - 4 * sk('closer')) return idle(signed(h, sid, t));
  setStatus(h, 'inspected'); addAgenda('followup', sid, h.i, SAVE.day + 1, { tries: 0 }); gain(5, 'Estimate left with ' + h.name);
  var key = PERSONA[h.persona].elder || h.persona === 'landlord' || h.persona === 'diy' ? 'thrifty' : h.persona;
  var why = tierScore(h, t) < 25 ? ({ thrifty: 'They wanted the sensible option, not the fanciest.', skeptic: 'They wanted the strongest warranty, not the cheapest.' }[key] || "That option didn't fit what they care about.") : 'Not enough trust or proof yet.';
  idle({ text: h.name + ' wants to think about it. ' + why + ' A follow-up is on tomorrow\'s list.' });
}

// ── Today-list actions ──
function runAgenda(a) {
  if (!DAY || DAY.over) return;
  var h = houseAt(a.sid, a.i);
  showTab('street');
  if (a.type === 'supplement') { dropAgenda(a.id); return supplement(h, a); }
  goToStreet(streetOf(a.sid), function () {
    if (!DAY || DAY.over) return;
    dropAgenda(a.id);
    if (a.type === 'inspect') { spend(15); if (!DAY || DAY.over) return; say(h.look, h.name, "Right on time. Come on up.", [{ say: 'Get the ladder', act: function () { inspect(h, a.sid); } }]); return; }
    if (a.type === 'followup') return followup(h, a);
    if (a.type === 'build') return buildJob(h, a);
    adjuster(h, a);
  });
}
function followup(h, a) {
  spend(AG_MIN.followup); if (!DAY || DAY.over) return;
  say(h.look, h.name, h.name + ' has had your estimate for a day. What do you send?', [
    { say: '"Hi ' + h.name + ', any questions on the estimate? Happy to walk through it line by line."', act: function () { fu(10); } },
    { say: '"Prices go up Friday! Sign today to lock it in."', act: function () { fu(-15, { text: 'Fake deadlines read as pressure. People can tell.' }); } },
    { say: '"Here are the photos from your roof again, with the damage circled."', act: function () { fu(h.damage === 'old' || h.damage === 'none' ? 4 : 14); } },
  ]);
  function fu(bump, tip) {
    h.trust = Math.max(0, Math.min(100, h.trust + bump));
    var want = TIERS.filter(function (t) { return t.key === PERSONA[h.persona].want; })[0];
    var score = h.trust + (SAVE.badges.walk ? 5 : 0) + (owns('ipad') ? 5 : 0) + (h.found || 0) * 40 + 25 + rnd(15) - 7 - (a.tries ? 5 : 0);
    if (score >= 80 - 4 * sk('closer')) return idle(signed(h, a.sid, want));
    if ((a.tries || 0) >= 1) { setStatus(h, 'quiet'); gain(3, 'Followed up with ' + h.name); return idle(tip || { text: h.name + ' went quiet. It happens. Doors reopen later.' }); }
    addAgenda('followup', a.sid, h.i, SAVE.day + 1, { tries: (a.tries || 0) + 1 }); gain(3, 'Followed up with ' + h.name);
    idle(tip || { text: h.name + ' says they\'re still deciding. One more follow-up tomorrow.' });
  }
}
function adjuster(h, a) {
  spend(AG_MIN.adjuster); if (!DAY || DAY.over) return;
  var score = 35 + (h.found || 0) * 30;
  say(ADJUSTER, 'Pat (adjuster)', "I'm here for " + h.name + "'s claim. You the contractor?", [
    { say: "Yes. I'm here because " + h.name + " asked me to show you what I found. It's their claim.", act: function () { score += 10; square(); } },
    { say: "I'm handling this claim for " + h.name + ". Let's talk numbers.", act: function () { DAY.clean = false; score -= 40; square({ bad: true, text: "Negotiating a claim for the homeowner is public-adjuster work, and it's illegal for a Kentucky contractor. Pat noticed." }); } },
  ]);
  function square(tip) {
    say(ADJUSTER, 'Pat (adjuster)', "Let's chalk a test square. Help me find the hits.", [{ say: 'Grab the chalk', act: function () {
      gridGame({ title: 'Test square', help: 'Chalk every hail hit inside the 10×10 test square. Pat needs 8 to call it.', cols: 6, rows: 6, cell: 30, n: h.damage === 'hail' ? 10 : 6,
        seconds: 12 + (SAVE.badges.tools ? 3 : 0), roof: h.roof, style: 'hail', chalk: true, square: true },
        function (found) { score += found >= 8 ? 25 : found * 2; last(found); });
    } }], tip);
  }
  function last(found) {
    say(ADJUSTER, 'Pat (adjuster)', found >= 8 ? "That's " + found + " in the square. I'm seeing it." : "Only " + found + " in the square. I'm not sure it's enough.", [
      { say: "Here's my photo log from the inspection, every spot dated.", act: function () { score += (h.found || 0) * 20; verdict(); } },
      { say: "Come on, this roof is obviously totaled!", act: function () { score -= 15; verdict({ text: 'Arguing with the adjuster helps nobody. Evidence does the talking.' }); } },
      { say: "Approve it and I'll take care of " + h.name + "'s deductible.", act: function () { DAY.clean = false; setStatus(h, 'lost'); idle({ bad: true, text: 'Offering to cover a deductible in front of the adjuster is fraud. The job is gone, and that\'s the least of it.' }); } },
    ]);
  }
  function verdict(tip) {
    if (score >= 70) {
      setStatus(h, 'approved'); newApproval(h); gain(40, 'Claim approved at ' + h.name + "'s");
      addAgenda('supplement', a.sid, h.i, SAVE.day);
      idle({ good: true, text: (tip ? tip.text + ' ' : '') + 'Pat approves the claim. Pick a build day on the crew board, and you collect when it\'s done (no money up front on insurance jobs). Pat\'s scope sheet is on your list: check it for missed items before the build.' });
    } else {
      setStatus(h, 'denied'); gain(10, 'Showed up for ' + h.name + "'s adjuster meeting");
      idle({ text: (tip ? tip.text + ' ' : '') + "Pat denies it. " + h.name + " can ask the insurer for a re-inspection; you can't argue the claim for them." });
    }
  }
}

// ── Sound ──
var SND = { on: true, ctx: null };
try { SND.on = localStorage.getItem('roofrep.sound') !== 'off'; } catch (_) {}
function tone(freq, t0, dur, type, vol) {
  var c = SND.ctx, o = c.createOscillator(), g2 = c.createGain();
  o.type = type || 'square'; o.frequency.setValueAtTime(freq, c.currentTime + t0);
  g2.gain.setValueAtTime(vol || 0.06, c.currentTime + t0); g2.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
  o.connect(g2); g2.connect(c.destination); o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur + 0.02);
}
function sfx(name) {
  if (!SND.on) return;
  try {
    if (!SND.ctx) SND.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (SND.ctx.state === 'suspended') SND.ctx.resume();
    var P = {
      knock: [[110, 0, .08, 'triangle', .2], [110, .14, .08, 'triangle', .2]],
      cash: [[988, 0, .07], [1319, .07, .2]],
      level: [[523, 0, .1], [659, .1, .1], [784, .2, .1], [1047, .3, .25]],
      ring: [[880, 0, .1], [988, .12, .1], [880, .24, .1], [988, .36, .1]],
      bump: [[90, 0, .18, 'sawtooth', .12]],
      good: [[659, 0, .08], [880, .08, .14]],
      bad: [[220, 0, .12, 'square', .07], [165, .12, .2, 'square', .07]],
      bark: [[300, 0, .06, 'sawtooth', .1], [250, .1, .08, 'sawtooth', .1]],
      trophy: [[784, 0, .1], [988, .1, .1], [1175, .2, .1], [1568, .3, .3]],
    }[name] || [];
    P.forEach(function (n) { tone(n[0], n[1], n[2], n[3], n[4]); });
  } catch (_) {}
}

// ── Trophies ──
var TROPHIES = [
  { k: 'clean7', ico: '🧼', name: 'Clean week', what: '7 clean days in a row', test: function () { return (SAVE.cleanStreak || 0) >= 7; } },
  { k: 'chad', ico: '🥊', name: 'Chad who?', what: 'Beat Storm Bros at 5 doors', test: function () { return st('rivals') >= 5; } },
  { k: 'bosses', ico: '👑', name: 'Boss slayer', what: 'Sign all three boss doors', test: function () { return st('bosses') >= 3; } },
  { k: 'stars', ico: '⭐', name: 'Five stars', what: 'Earn five 5★ reviews', test: function () { return SAVE.reviews.filter(function (r) { return r === 5; }).length >= 5; } },
  { k: 'honest', ico: '🤝', name: 'Straight shooter', what: 'Tell 3 homeowners their roof is fine', test: function () { return st('honest') >= 3; } },
  { k: 'paper', ico: '📋', name: 'Paper trail', what: 'Document 5 supplements', test: function () { return st('supps') >= 5; } },
  { k: 'fix', ico: '🔧', name: 'Fix it right', what: 'Diagnose 5 gutter or repair jobs', test: function () { return st('repairs') >= 5; } },
  { k: 'road', ico: '🛻', name: 'Road warrior', what: '10 drives without a scratch', test: function () { return st('drives') >= 10; } },
  { k: 'phone', ico: '📞', name: 'Phone pro', what: 'Handle 10 calls the right way', test: function () { return st('calls') >= 10; } },
  { k: 'six', ico: '💰', name: 'Six figures', what: 'Collect $100,000', test: function () { return SAVE.collected >= 100000; } },
  { k: 'seasons', ico: '🗓', name: 'Four seasons', what: 'Work a day in every season', test: function () { return Object.keys(SAVE.seasons || {}).length >= 4; } },
  { k: 'class', ico: '🎓', name: 'Top of the class', what: 'Earn all six training badges', test: function () { return Object.keys(SAVE.badges).length >= 6; } },
  { k: 'allBosses', ico: '🏆', name: 'Boss of bosses', what: 'Sign all six boss doors', test: function () { return st('bosses') >= 6; } },
  { k: 'cat', ico: '🌪', name: 'Eye of the storm', what: 'Work a catastrophe storm day', test: function () { return st('cat') >= 1; } },
  { k: 'oldtown', ico: '🏛', name: 'Key to the city', what: 'Unlock Old Town (level 10)', test: function () { return lvl() >= 10; } },
  { k: 'legend', ico: '🌟', name: 'Legend', what: 'Reach the Legend title', test: function () { return lvl() >= 8; } },
  { k: 'stars10', ico: '✨', name: 'Fan favorite', what: 'Earn ten 5★ reviews', test: function () { return SAVE.reviews.filter(function (r) { return r === 5; }).length >= 10; } },
  { k: 'quarter', ico: '🏦', name: 'Quarter million', what: 'Collect $250,000', test: function () { return SAVE.collected >= 250000; } },
  { k: 'cleanMonth', ico: '😇', name: 'Spotless month', what: '28 clean days in a row', test: function () { return (SAVE.cleanStreak || 0) >= 28; } },
  { k: 'calls25', ico: '☎', name: 'Switchboard', what: 'Handle 25 calls the right way', test: function () { return st('calls') >= 25; } },
  { k: 'handy', ico: '🪛', name: 'Handyman', what: 'Diagnose 15 gutter or repair jobs', test: function () { return st('repairs') >= 15; } },
  { k: 'crm10', ico: '🗂', name: 'Clean books', what: '10 perfect CRM logs', test: function () { return st('crm') >= 10; } },
  { k: 'dogs', ico: '🐕', name: 'Dog whisperer', what: 'Calm 5 barking dogs the right way', test: function () { return st('dogs') >= 5; } },
  { k: 'tarp', ico: '⛺', name: 'First responder', what: 'Tarp 3 emergency leaks', test: function () { return st('tarps') >= 3; } },
  { k: 'news', ico: '📺', name: 'Straight talk on TV', what: 'Give an honest news interview', test: function () { return st('news') >= 1; } },
  { k: 'safety', ico: '🦺', name: 'Safety first', what: 'Earn all three training badges', test: function () { return Object.keys(SAVE.badges).length >= 3; } },
];
function st(k) { return (SAVE.stats && SAVE.stats[k]) || 0; }
function stat(k, n) { SAVE.stats = SAVE.stats || {}; SAVE.stats[k] = st(k) + (n || 1); if (DAY) dayCount(k); checkTrophies(); }
function checkTrophies() {
  SAVE.trophies = SAVE.trophies || {};
  TROPHIES.forEach(function (t) {
    if (SAVE.trophies[t.k] || !t.test()) return;
    SAVE.trophies[t.k] = SAVE.day; sfx('trophy');
    setTimeout(function () { toast('TROPHY: ' + t.ico + ' ' + t.name.toUpperCase() + ' · +50 XP'); }, 900);
    gainAny(50, 'Trophy: ' + t.name);
  });
}
function trophiesHtml() {
  var got = Object.keys(SAVE.trophies || {}).length;
  return '<div class="card"><h2>TROPHY WALL · ' + got + '/' + TROPHIES.length + '</h2><div class="trophies">' + TROPHIES.map(function (t) {
    var has = SAVE.trophies && SAVE.trophies[t.k];
    return '<div class="trophy' + (has ? ' got' : '') + '"><span class="ico">' + t.ico + '</span><b>' + esc(t.name) + '</b><small>' + esc(t.what) + (has ? ' · day ' + has : '') + '</small></div>';
  }).join('') + '</div></div>';
}

// ── Daily challenge ──
var CHALLENGES = [
  { k: 'knock', need: 8, text: 'Knock 8 doors' },
  { k: 'insp', need: 3, text: 'Inspect 3 roofs' },
  { k: 'sign', need: 2, text: 'Sign 2 jobs' },
  { k: 'calls', need: 2, text: 'Handle 2 calls the right way' },
  { k: 'drives', need: 2, text: 'Make 2 drives without a scratch' },
  { k: 'rivals', need: 1, text: 'Beat Storm Bros at a door', when: function () { return STREETS.some(function (x) { return lvl() >= x.level && rivalStreet(x.id); }); } },
  { k: 'dogs', need: 1, text: 'Calm a barking dog the right way', when: function () { return allHouses().some(function (x) { return x.h.dog && x.h.status === 'fresh' && lvl() >= streetOf(x.sid).level; }); } },
  { k: 'repairs', need: 1, text: 'Diagnose a gutter or repair job', when: function () { return allHouses().some(function (x) { return (x.h.damage === 'gutter' || x.h.damage === 'repair') && x.h.status === 'fresh' && lvl() >= streetOf(x.sid).level; }); } },
  { k: 'supps', need: 1, text: 'Document a supplement', when: function () { return SAVE.agenda.some(function (a) { return a.type === 'supplement'; }) || allHouses().some(function (x) { return x.h.status === 'signed'; }); } },
  { k: 'honest', need: 1, text: "Tell a homeowner their roof is fine (when it is)" },
  { k: 'review', need: 1, text: 'Earn a 5★ review', when: function () { return allHouses().some(function (x) { return x.h.status === 'approved' && x.h.buildDay === SAVE.day; }); } },
];
function dayCount(k) {
  if (!DAY || !DAY.ch) return;
  DAY.counts = DAY.counts || {}; DAY.counts[k] = (DAY.counts[k] || 0) + 1;
  if (DAY.ch.k === k && !DAY.ch.done && DAY.counts[k] >= DAY.ch.need) { DAY.ch.done = true; sfx('good'); toast('CHALLENGE DONE: ' + DAY.ch.text.toUpperCase() + ' · +40 XP'); gain(40, 'Daily challenge: ' + DAY.ch.text); }
}
function challengeHtml() {
  if (!DAY || !DAY.ch) return '';
  var have = Math.min(DAY.ch.need, (DAY.counts && DAY.counts[DAY.ch.k]) || 0), pct = Math.round(have / DAY.ch.need * 100);
  return '<div class="card' + (DAY.ch.done ? '' : ' hl') + '"><h3>TODAY\'S CHALLENGE · +40 XP</h3><div class="chal"><span>' + esc(DAY.ch.text) + '</span><b>' + have + '/' + DAY.ch.need + '</b></div><div class="bar"><i class="rr-w' + Math.round(pct / 5) * 5 + '"></i></div></div>';
}

// ── End of day: log it in the CRM ──
var NEXT = {
  later: 'Revisit in 2 days', hanger: 'Revisit in 2 days', lost: 'Close it out with a note why', booked: 'Inspection on tomorrow\'s calendar',
  inspected: 'Follow-up task for tomorrow', signed: 'Adjuster meeting on the calendar', approved: 'Get a build date on the board',
  built: 'Mark paid and request a review', fine: 'Note it: check again after the next storm', denied: 'Close it out with a note why',
  quiet: 'Close it out with a note why', rivaled: 'Close it out with a note why',
};
function crmLog(done) {
  var rows = Object.keys(DAY.events || {}).map(function (k) { return DAY.events[k]; }).filter(function (e) { return NEXT[e.h.status]; });
  if (!rows.length) return done();
  var steps = Object.keys(NEXT).map(function (k) { return NEXT[k]; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
  if (owns('office')) { gain(3 * rows.length + (rows.length >= 2 ? 20 : 0), 'Office manager logged ' + rows.length + ' lead' + (rows.length > 1 ? 's' : '')); return done(); }
  var right = 0, answered = 0;
  overlay('<h2>LOG IT IN THE CRM</h2><p class="help">Before you clock out: give every lead you touched today its next step. Clean records are how nothing falls through the cracks.</p><div id="lg"></div><div class="row"><button type="button" class="btn primary" id="lgDone">Clock out</button><button type="button" class="btn" id="lgSkip">Skip it</button></div>');
  var box = document.getElementById('lg');
  rows.forEach(function (e) {
    var ok = NEXT[e.h.status], opts = shuffle([ok].concat(shuffle(steps.filter(function (x) { return x !== ok; })).slice(0, 2)));
    var r = document.createElement('div'); r.className = 'logrow';
    var t = document.createElement('div'); t.textContent = e.h.name + ' · ' + (e.h.tag ? e.h.tag + ' · ' : '') + e.h.status; r.appendChild(t);
    var c = document.createElement('div'); c.className = 'choices';
    opts.forEach(function (o) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = o;
      b.addEventListener('click', function () {
        if (c.dataset.done) return; c.dataset.done = '1'; answered++;
        if (o === ok) { right++; b.classList.add('right'); } else { b.classList.add('wrong'); Array.prototype.forEach.call(c.children, function (x) { if (x.textContent === ok) x.classList.add('right'); }); }
      });
      c.appendChild(b);
    });
    r.appendChild(c); box.appendChild(r);
  });
  document.getElementById('lgDone').addEventListener('click', function () {
    closeOverlay();
    if (right) gain(3 * right, 'Logged ' + right + ' lead' + (right > 1 ? 's' : '') + ' in the CRM');
    if (right === rows.length && rows.length >= 2) { gain(20, 'Perfect CRM log'); stat('crm'); }
    done();
  });
  document.getElementById('lgSkip').addEventListener('click', function () { closeOverlay(); done(); });
}

// ── Seasons ──
var SEASONS = ['spring', 'summer', 'fall', 'winter'];
var SEASON = {
  spring: { name: 'Spring', icon: '🌱', note: 'Hail season: storms roll through every couple of days.', tree: '#2f7a35', leaf: '#3d9444' },
  summer: { name: 'Summer', icon: '🔥', note: 'Heat on the roof. Hydrate or pay for it.', tree: '#2a6b2f', leaf: '#4a9a40' },
  fall: { name: 'Fall', icon: '🍂', note: 'Leaves are filling gutters: gutter jobs everywhere.', tree: '#c2452d', leaf: '#e0b45a' },
  winter: { name: 'Winter', icon: '❄', note: 'Ice dams and frost: leak repairs, and no climbing before 11 AM.', tree: '#5a6a5a', leaf: '#e8eef2' },
};
function seasonFor(day) { return SEASONS[Math.floor((day - 1) / 7) % 4]; }

// ── The rival: Chad from Storm Bros works storm streets ──
var RIVAL_LOOK = { skin: 1, hair: 'spiky', hairColor: 3, eyes: 'wink', hat: 'cap', hatColor: 2, beard: 'none', shirt: 5, vest: 'none', pants: 2, tool: 'none', extra: 'shades' };
var RIVAL = { x: 340, y: 100, tx: 340, ty: 100 };
function rivalStreet(sid) { var last = SAVE.lastStorm && SAVE.lastStorm[sid]; return sid === 'hollow' || (last != null && SAVE.day - last <= 3); }
function rivalMove() {
  if (!DAY || !rivalStreet(SAVE.streetId) || Math.random() > (SAVE.lastCat && SAVE.day - SAVE.lastCat <= 3 ? 0.6 : 0.35)) return;
  var targets = ensureStreet(SAVE.streetId).houses.filter(function (h) { return h.status === 'fresh' && !h.rival && (h.damage === 'hail' || h.damage === 'some') && h.persona !== 'empty' && h.persona !== 'nosolicit' && !PERSONA[h.persona].boss; });
  if (!targets.length) return;
  var h = pick(targets), d = doorOf(h); h.rival = SAVE.day; RIVAL.tx = d.x + 12; RIVAL.ty = d.y;
}
function rivalTalk(h, tip) {
  say(h.look, h.name, "A guy from Storm Bros Roofing was just here. Said he'd cover my deductible if I signed today, before his \"storm price\" runs out.", [
    { say: "I'd be careful. Covering a deductible is illegal in Kentucky, and an honest price doesn't expire in an hour. Can I show you what a straight deal looks like?", act: function () {
      h.trust = Math.min(100, h.trust + 15); h.rivalBeat = true; spend(4); if (!DAY || DAY.over) return; gain(15, 'Beat Storm Bros with the truth at ' + h.name + "'s"); stat('rivals'); sfx('good');
      node(h, 'start', { good: true, text: 'Facts beat pressure. ' + h.name + ' is listening now.' });
    } },
    { say: "I'll match him. I'll cover your deductible too.", act: function () {
      DAY.clean = false; spend(4); if (!DAY || DAY.over) return; setStatus(h, 'lost');
      idle({ bad: true, text: 'Matching an illegal offer just makes you the second guy breaking the law on this porch. Deal lost.' });
    } },
    { say: "That guy's a crook. Don't trust him.", act: function () {
      h.trust = Math.max(0, h.trust - 10); h.rivalBeat = true; spend(4); if (!DAY || DAY.over) return;
      node(h, 'start', { text: 'Name-calling makes you sound like him. Let the facts do the talking.' });
    } },
  ], tip);
}

// ── Gutters and repairs: diagnose the real problem ──
var CAUSES = {
  boot: { what: 'A cracked pipe boot over the bathroom is letting water in.', fix: 'Replace the pipe boot and reseal', price: 350 },
  flash: { what: 'The step flashing at the chimney has pulled loose.', fix: 'Re-flash the chimney', price: 750 },
  nails: { what: 'Nails have popped under the ridge and the shingles above them are lifting.', fix: 'Reset the nails and reseal the ridge', price: 450 },
  icedam: { what: 'An ice dam at the eave backed water up under the shingles.', fix: 'Remove the ice dam and retrofit ice & water shield at the eave', price: 900 },
};
function soldSmall(h, sid, price, label) {
  h.price = price; h.small = true; DAY.signed++; DAY.sold += price;
  setStatus(h, 'approved'); h.buildDay = SAVE.day + 1;
  gain(25 + Math.round(price / 100), h.name + ' said yes: ' + label + ' ' + money(price)); stat('repairs'); sfx('cash');
  idle({ good: true, text: 'Right fix, fair price. The repair tech handles it tomorrow, and you collect when it\'s done.' });
}
function pitchSmall(h, sid) {
  if (h.damage === 'gutter') {
    var lf = 110 + rnd(90), gp = Math.max(1000, Math.round(lf * 8.5));
    return say(h.look, h.name, 'You show ' + h.name + ' the photos: the shingles are fine, but ' + lf + ' feet of gutter is dented and pulling off the fascia. What do you recommend?', [
      { say: 'Replace the damaged runs with new seamless gutters · ' + money(gp), act: function () { spend(10); if (!DAY || DAY.over) return; soldSmall(h, sid, gp, 'new gutters'); } },
      { say: 'Put gutter guards on the dented gutters', act: function () { spend(10); if (!DAY || DAY.over) return; h.trust = Math.max(0, h.trust - 15); setStatus(h, 'later'); idle({ text: 'Guards on bent gutters still overflow. Fix the gutters first; guards are an add-on, not a repair.' }); } },
      { say: 'Recommend a whole new roof while you\'re at it.', act: function () { spend(10); if (!DAY || DAY.over) return; DAY.clean = false; h.trust = Math.max(0, h.trust - 30); setStatus(h, 'quiet'); idle({ bad: true, text: 'The roof was fine. Selling what isn\'t needed is how you lose a customer for life.' }); } },
    ]);
  }
  if (!h.cause) h.cause = seasonFor(SAVE.day) === 'winter' && Math.random() < .5 ? 'icedam' : pick(['boot', 'flash', 'nails']);
  var C2 = CAUSES[h.cause];
  var opts = shuffle(Object.keys(CAUSES)).slice(0, owns('meter') ? 2 : 3);
  if (opts.indexOf(h.cause) < 0) opts[0] = h.cause;
  say(h.look, h.name, 'You found the leak. ' + C2.what + ' What do you recommend?', shuffle(opts).map(function (k) {
    return { say: CAUSES[k].fix + ' · ' + money(CAUSES[k].price), act: function () {
      spend(10); if (!DAY || DAY.over) return;
      if (k === h.cause) return soldSmall(h, sid, CAUSES[k].price, 'repair');
      h.trust = Math.max(0, h.trust - 15); setStatus(h, 'later');
      idle({ text: "That fix doesn't touch the real problem. It would leak again next rain. Read the roof: " + C2.what });
    } };
  }).concat([{ say: 'Recommend a full replacement instead.', act: function () {
    spend(10); if (!DAY || DAY.over) return; DAY.clean = false; h.trust = Math.max(0, h.trust - 30); setStatus(h, 'quiet');
    idle({ bad: true, text: 'A ' + money(C2.price) + ' repair fixes this. Selling a whole roof instead is how you lose your name.' });
  } }]));
}

// ── Crew board: pick build days around the forecast ──
function crewCap(d) { return wet(weatherFor(d)) || supplyShort(d) ? 0 : owns('crew2') ? 2 : 1; }
function jobsOn(d) { return allHouses().filter(function (x) { return !x.h.small && ((x.h.status === 'approved' && x.h.buildDay === d) || (x.h.status === 'building' && SAVE.day === d && DAY)); }); }
function unscheduled() { return allHouses().filter(function (x) { return x.h.status === 'approved' && !x.h.small && x.h.buildDay == null; }); }
function firstOpenDay() { return SAVE.day + (DAY ? 1 : 0); }
function crewBoardHtml() {
  var start = SAVE.day, html = '<div class="card' + (unscheduled().length ? ' hl' : '') + '"><h2>CREW BOARD · 7 DAYS</h2><p class="help">' + (owns('crew2') ? 'Two crews: up to 2 builds a day.' : 'One crew: 1 build a day.') + ' No builds on wet days. Homeowners have days they can\'t do.</p><div class="cb">';
  for (var d = start; d < start + 7; d++) {
    var w = weatherFor(d), jobs = jobsOn(d), cap = crewCap(d);
    html += '<div' + (d === SAVE.day ? ' class="today"' : '') + '><b>' + (d === SAVE.day ? 'Today' : 'D' + d) + '</b><span class="wx">' + WX[w].icon + '</span>' +
      jobs.map(function (x) { return '<span class="job">' + esc(x.h.name) + '</span>'; }).join('') +
      (cap === 0 ? '<span class="no">' + (supplyShort(d) ? 'no shingles' : 'no build') + '</span>' : cap > jobs.length ? '<span class="open">' + (cap - jobs.length) + ' open</span>' : '') + '</div>';
  }
  html += '</div>';
  var un = unscheduled();
  if (un.length) html += un.map(function (x) {
    var wait = SAVE.day - x.h.since;
    return '<div class="item"><div class="d">' + esc(x.h.name) + ' · ' + money(x.h.price + (x.h.supp || 0)) + '<small>' + (x.h.noDay ? "Can't do day " + x.h.noDay + ' (' + esc(x.h.noWhy) + ')' : 'Any day works') + (wait >= 2 ? ' · waiting ' + wait + ' days' : '') + '</small></div><button type="button" class="btn" data-sched="' + x.sid + ':' + x.h.i + '">Schedule</button></div>';
  }).join('');
  else html += '<p class="help">Nothing waiting on a build date.</p>';
  return html + '</div>';
}
function schedulePicker(sid, i) {
  var h = houseAt(sid, i), from = firstOpenDay(), html = '';
  for (var d = from; d < from + 7; d++) {
    var w = weatherFor(d), full = jobsOn(d).length >= crewCap(d), blocked = h.noDay === d;
    var why = crewCap(d) === 0 ? (supplyShort(d) ? 'supply short' : 'wet, no builds') : blocked ? h.name + " can't" : full ? 'crew booked' : WX[w].name;
    html += '<button type="button" class="btn" data-day="' + d + '"' + (full || blocked ? ' disabled' : '') + '>' + WX[w].icon + ' Day ' + d + (d === SAVE.day ? ' (today)' : '') + ' · ' + esc(why) + '</button>';
  }
  overlay('<h2>SCHEDULE ' + esc(h.name.toUpperCase()) + '</h2><p class="help">Pick a build day. You collect when the roof is done.</p><div class="choices" id="pick">' + html + '</div><button type="button" class="btn" id="pickX">Not now</button>');
  document.querySelectorAll('#pick [data-day]').forEach(function (b) { b.addEventListener('click', function () {
    var d = Number(b.dataset.day); h.buildDay = d; h.noDay = h.noDay === d ? null : h.noDay;
    closeOverlay(); gainAny(5, 'Scheduled ' + h.name + "'s build for day " + d); renderToday(); hud();
  }); });
  document.getElementById('pickX').addEventListener('click', closeOverlay);
}
function newApproval(h) {
  h.buildDay = null;
  if (Math.random() < 0.5) { h.noDay = SAVE.day + 1 + rnd(4); h.noWhy = pick(["their kid's graduation", 'out of town', 'hosting a party', 'new baby coming home', 'work from home, big meeting']); } else h.noDay = null;
}

// ── Build day ──
function repStars() { return SAVE.reviews.length ? SAVE.reviews.reduce(function (a, b) { return a + b; }, 0) / SAVE.reviews.length : 0; }
var LAYERS = [
  { name: 'Decking repairs', c: '#b98a4e' }, { name: 'Drip edge', c: '#9aa0a6' }, { name: 'Ice & water shield', c: '#2c2c2a' },
  { name: 'Synthetic underlayment', c: '#7aa0c8' }, { name: 'Starter strip', c: '#6b5a4a' }, { name: 'Shingles', c: '#4a4f5a' },
  { name: 'Flashing and vents', c: '#c9ccd1' }, { name: 'Ridge cap', c: '#2f343c' },
];
function drawBuild(cv, done) {
  var c = cv.getContext('2d'), W2 = cv.width, H2 = cv.height;
  c.fillStyle = '#8ec5ff'; c.fillRect(0, 0, W2, H2);
  c.fillStyle = '#356b31'; c.fillRect(0, H2 - 24, W2, 24);
  c.fillStyle = '#e0cfa8'; c.fillRect(70, 100, 180, H2 - 124);
  c.fillStyle = '#6b3a24'; c.fillRect(150, 130, 20, H2 - 154);
  // rafters
  c.strokeStyle = '#8b5a2b'; c.lineWidth = 3; c.beginPath(); c.moveTo(50, 104); c.lineTo(160, 30); c.lineTo(270, 104); c.stroke();
  for (var i = 0; i < done; i++) {
    var L = LAYERS[i], off = i * 3;
    c.strokeStyle = L.c; c.lineWidth = i === 5 ? 6 : 3;
    if (i === 7) { c.fillStyle = L.c; c.fillRect(150, 22 - off / 3, 20, 8); continue; }
    if (i === 6) { c.fillStyle = L.c; c.fillRect(110, 52, 6, 14); c.fillRect(200, 56, 10, 6); continue; }
    if (i === 1) { c.fillStyle = L.c; c.fillRect(46, 102, 8, 4); c.fillRect(266, 102, 8, 4); continue; }
    c.beginPath(); c.moveTo(50, 102 - off); c.lineTo(160, 28 - off); c.lineTo(270, 102 - off); c.stroke();
  }
}
function buildJob(h, a) {
  spend(AG_MIN.build); if (!DAY || DAY.over) return;
  var q = { stars: 5, co: 0, notes: [] }, next = 0, misses = 0;
  say(FOREMAN, 'Big Dave (foreman)', 'Tear-off is done at ' + h.name + "'s. Bad news: three sheets of decking are soft. What's the call?", [
    { say: 'Stop. Show ' + h.name + ' the photos and get a signed change order before we replace it.', act: function () { q.co = 285; q.notes.push('Change order signed for decking ($285).'); layers(); } },
    { say: 'Replace it and add it to the bill. They will understand.', act: function () { q.co = 285; q.stars -= 2; h.trust = Math.max(0, h.trust - 20); q.notes.push('Surprise charges on the final bill cost you trust.'); layers({ bad: true, text: 'Surprise charges sink reviews. Changes get explained and signed before the work, every time.' }); } },
    { say: 'Shingle right over it. Nobody will see it.', act: function () { q.stars -= 3; q.notes.push('Shingling over soft decking: the roof will sag and leak.'); layers({ bad: true, text: 'Covering rotten decking is a callback waiting to happen, and the homeowner pays for it later.' }); } },
  ]);
  function layers(tip) {
    overlay('<h2>BUILD · ' + esc(h.name.toUpperCase()) + '</h2><p class="help">Put the roof on, bottom layer first. Tap the layers in order.</p><canvas class="mg" id="bd" width="320" height="180" aria-label="Roof cross-section"></canvas><div class="tools" id="bl"></div><p class="help" id="blF">Mistakes: 0</p>' + (tip ? '<div class="tip bad">' + esc(tip.text) + '</div>' : ''));
    var cv = document.getElementById('bd'), box = document.getElementById('bl');
    drawBuild(cv, 0);
    shuffle(LAYERS.map(function (L, i) { return { L: L, i: i }; })).forEach(function (o) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = o.L.name;
      b.addEventListener('click', function () {
        if (b.dataset.used) return;
        if (o.i === next) { b.dataset.used = '1'; b.classList.add('right'); b.disabled = true; next++; drawBuild(cv, next); if (next === LAYERS.length) setTimeout(function () { closeOverlay(); nailing(function (hits) { if (hits < 4) { q.stars -= 1; q.notes.push('Only ' + hits + ' of 6 nails on the line: those shingles can blow off.'); } else q.notes.push(hits + '/6 nails on the line.'); storm(); }); }, 450); }
        else { misses++; b.classList.add('wrong'); setTimeout(function () { b.classList.remove('wrong'); }, 400); document.getElementById('blF').textContent = 'Mistakes: ' + misses + '. Not yet: what goes on before that?'; }
      });
      box.appendChild(b);
    });
  }
  function storm() {
    if (misses > 2) { q.stars -= 1; q.notes.push('Layers went on out of order (' + misses + ' mistakes).'); }
    closeOverlay();
    if (Math.random() < 0.45 || DAY.wx === 'wind') {
      say(FOREMAN, 'Big Dave (foreman)', 'Storm cell on the radar for 3 PM and the ridge is still open.', [
        { say: 'Tarp and secure the open sections now. We finish after it passes.', act: function () { spend(20); if (!DAY || DAY.over) return; q.notes.push('Tarped ahead of the storm.'); sweep(); } },
        { say: 'Keep going and hope it misses us.', act: function () { if (Math.random() < 0.6) { q.stars -= 2; h.trust = Math.max(0, h.trust - 15); q.notes.push('Rain got into the attic. Drywall stains, unhappy homeowner.'); } else q.notes.push('Got lucky with the storm. Do not count on that.'); sweep(); } },
      ]);
    } else sweep();
  }
  function sweep() {
    if (!q.inspector && Math.random() < 0.4) {
      q.inspector = true;
      return say({ skin: 4, hair: 'buzz', hairColor: 0, eyes: 'round', hat: 'hardhat', hatColor: 4, beard: 'none', shirt: 3, vest: 'yes', pants: 2, tool: 'none', extra: 'glasses', clipboard: true }, 'City inspector', 'Routine check. Show me the permit and the ice and water shield at the eaves.', [
        { say: "Permit's in the front window. Here are this morning's photos of the ice and water shield going down.", act: function () { gain(15, 'Passed the city inspection'); q.notes.push('Passed the city inspection.'); stat('inspections'); sweep(); } },
        { say: "We don't really pull permits for re-roofs.", act: function () { DAY.clean = false; q.stars -= 2; q.notes.push('Stop-work order: no permit. The homeowner had to wait while you pulled one.'); spend(60); if (!DAY || DAY.over) return; sweep(); } },
      ]);
    }
    say(FOREMAN, 'Big Dave (foreman)', "Roof's on. Last thing before the walkthrough: magnet sweep. Every nail we leave is somebody's flat tire.", [{ say: 'Grab the magnet', act: function () {
      gridGame({ title: 'Magnet sweep', help: 'Tap every nail in the yard and driveway before the homeowner pulls in.', cols: 8, rows: 5, cell: 26, n: 9, seconds: 12, roof: '#3d7a3a', style: 'nail' },
        function (found, n) {
          if (n - found >= 3) { q.stars -= 1; q.notes.push((n - found) + ' nails left in the yard.'); } else q.notes.push('Yard swept clean (' + found + '/' + n + ').');
          walkthrough();
        });
    } }]);
  }
  function walkthrough() {
    var stars = Math.max(1, Math.min(5, q.stars));
    say(h.look, h.name, stars >= 5 ? 'It looks amazing. You even cleaned up better than you found it.' : stars >= 3 ? "It looks good. A couple of things weren't perfect, but okay." : "Honestly? I'm not thrilled with how this went.", [
      { say: 'Walk the roof with ' + h.name + ', answer every question, then ask for an honest review.', act: function () { finishBuild(stars, true); } },
      { say: 'Hand over the paperwork and head out.', act: function () { finishBuild(stars, false); } },
    ]);
  }
  function finishBuild(stars, asked) {
    dropAgenda(a.id);
    h.co = q.co;
    if (asked) { SAVE.reviews.push(stars); if (stars === 5) dayCount('review'); }
    completeBuild(h, a.sid, asked ? stars : 0, q.notes);
  }
}
function completeBuild(h, sid, stars, notes) {
  var amt = h.price + (h.supp || 0) + (h.co || 0);
  setStatus(h, 'built');
  DAY.collected += amt; SAVE.collected += amt; SAVE.bank += amt;
  SAVE.agenda = SAVE.agenda.filter(function (a) { return !(a.sid === sid && a.i === h.i && (a.type === 'supplement' || a.type === 'build')); });
  var ran = notes != null;
  sfx('cash');
  gain(40 + Math.round(amt / 1000) + (ran ? 25 + 10 * stars : 0), (ran ? 'Ran the build at ' : h.small ? 'Repair finished at ' : 'Crew finished ') + h.name + "'s roof; collected " + money(amt));
  var warmN = (owns('signs') ? 2 : 1) + (stars >= 5 ? 1 : 0);
  var warm = shuffle(ensureStreet(sid).houses.filter(function (x) { return x.status === 'fresh' && x.persona !== 'empty'; })).slice(0, warmN);
  warm.forEach(function (w) { w.trust += 15; w.referral = h.name; });
  if (ran) idle({ good: stars >= 4, bad: stars <= 2, text: (stars ? h.name + ' left a ' + stars + '★ review. ' : '') + 'Collected ' + money(amt) + '. ' + notes.join(' ') });
}

// ── Measure the roof before you price it ──
var PITCHES = [[4, 1.054], [6, 1.118], [8, 1.202], [10, 1.302]];
function measureStep(h, sid) {
  h.measured = true;
  var P = pick(PITCHES), area = Math.round(h.sq * 100 / 1.1 / P[1] / 10) * 10;
  var right = h.sq, noWaste = Math.round(h.sq / 1.1), noPitch = Math.round(area * 1.1 / 100);
  if (noPitch === right) noPitch = right - 3; if (noWaste === right) noWaste = right - 2; if (noWaste === noPitch) noWaste--;
  say(FOREMAN, 'Big Dave (foreman)', 'Before you price it: the footprint is ' + area.toLocaleString('en-US') + ' sq ft at a ' + P[0] + '/12 pitch (factor ' + P[1] + '). Add 10% waste. How many squares do we order?', shuffle([right, noWaste, noPitch]).map(function (n) {
    return { say: n + ' squares', act: function () {
      var ok = n === right; sfx(ok ? 'good' : 'bad');
      h.trust = Math.max(0, Math.min(100, h.trust + (ok ? 5 + (SAVE.badges.measure ? 3 : 0) : -10)));
      if (ok) { gain(10, 'Measured ' + h.name + "'s roof right"); stat('measure'); }
      pitchTiers(h, sid, ok ? { good: true, text: 'Area × pitch factor × 1.10 waste = ' + right + ' squares. Your numbers add up.' } : { bad: true, text: n === noWaste ? 'You forgot the 10% waste. Short on material means a second delivery and a crew standing around.' : 'You forgot the pitch factor. A steep roof has more surface than its footprint.' });
    } };
  }));
}

// ── Pick the photos for the homeowner's report ──
var PHOTOS_GOOD = ['Wide shot of the whole slope', 'Close-up of a hail hit, chalk-circled', 'Tape measure next to a bruise for scale', 'Dented gutter and downspout', 'Damaged vent cap', 'Granules washed into the gutter'];
var PHOTOS_BAD = ['Blurry shot of your boot', 'Selfie on the ridge', "The neighbor's roof", 'Thumb over the lens', 'Your truck in the driveway'];
function photoReport(h, done) {
  var good = shuffle(PHOTOS_GOOD).slice(0, 4), opts = shuffle(good.concat(shuffle(PHOTOS_BAD).slice(0, 4))), picked = {};
  overlay('<h2>PHOTO REPORT</h2><p class="help">Pick the 4 photos for the report you send ' + esc(h.name) + '. Good reports close deals; bad ones make you look careless.</p><div class="tools" id="ph"></div><div id="phF"></div><button type="button" class="btn primary wide" id="phGo">Send the report</button>');
  var box = document.getElementById('ph');
  opts.forEach(function (o) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = '📷 ' + o; b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', function () {
      if (box.dataset.done) return;
      var n = Object.keys(picked).filter(function (k) { return picked[k]; }).length;
      if (!picked[o] && n >= 4) return;
      picked[o] = !picked[o]; b.classList.toggle('on', picked[o]); b.setAttribute('aria-pressed', String(picked[o]));
    });
    box.appendChild(b);
  });
  document.getElementById('phGo').addEventListener('click', function () {
    if (box.dataset.done) return; box.dataset.done = '1';
    var chosen = Object.keys(picked).filter(function (k) { return picked[k]; }), g2 = chosen.filter(function (k) { return PHOTOS_GOOD.indexOf(k) >= 0; }).length;
    h.trust = Math.max(0, Math.min(100, h.trust + (g2 * 3 - (chosen.length - g2) * 4)));
    if (g2 === 4) { gain(10, 'Clean photo report for ' + h.name); stat('photos'); }
    closeOverlay(); done();
  });
}

// ── Nail the shingles: tap when the marker is on the nail line ──
function nailing(done) {
  var hits = 0, taps = 0, need = 6, maxTaps = 10, pos = 0, dir = 1, over = false, raf = 0;
  overlay('<h2>NAIL THE SHINGLES</h2><p class="help">Tap when the marker is on the green nail line. High-wind spec: 6 nails per shingle.</p><canvas class="mg" id="nl" width="320" height="90" aria-label="Shingle nailing"></canvas><div class="row"><b id="nlH">0/6 nails</b><span class="help grow" id="nlT">Taps left: 10</span><button type="button" class="btn primary" id="nlGo">Nail!</button></div>');
  var cv = document.getElementById('nl'), c = cv.getContext('2d'), z0 = 138, z1 = 176;
  function frame() {
    if (over) return;
    pos += dir * 4.4; if (pos > 300) { pos = 300; dir = -1; } if (pos < 0) { pos = 0; dir = 1; }
    c.fillStyle = '#4a4f5a'; c.fillRect(0, 0, 320, 90);
    c.fillStyle = '#3d4250'; for (var x = 0; x < 320; x += 40) c.fillRect(x, 0, 2, 90);
    c.fillStyle = 'rgba(123,201,111,.55)'; c.fillRect(z0, 0, z1 - z0, 90);
    c.fillStyle = '#7bc96f'; c.fillRect(z0, 44, z1 - z0, 2);
    c.fillStyle = '#f2a900'; c.fillRect(pos + 10, 10, 3, 70);
    raf = requestAnimationFrame(frame);
  }
  frame();
  function tap() {
    if (over) return;
    taps++;
    var x = pos + 11, ok = x >= z0 && x <= z1; if (ok) hits++;
    sfx(ok ? 'knock' : 'bad');
    document.getElementById('nlH').textContent = hits + '/6 nails'; document.getElementById('nlT').textContent = 'Taps left: ' + (maxTaps - taps);
    if (hits >= need || taps >= maxTaps) { over = true; cancelAnimationFrame(raf); document.removeEventListener('keydown', key); setTimeout(function () { closeOverlay(); done(hits); }, 300); }
  }
  function key(e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); } }
  cv.addEventListener('click', tap);
  document.getElementById('nlGo').addEventListener('click', tap);
  document.addEventListener('keydown', key);
}

// ── Town events ──
function supplyShort(d) { if (d < 5) return false; var x = Math.sin(d * 7.13 + (SAVE.seed || 1) * 3.7) * 9999; x -= Math.floor(x); return x < 0.08; }
var REPORTER = { skin: 3, hair: 'long', hairColor: 3, eyes: 'happy', hat: 'none', hatColor: 0, beard: 'none', shirt: 1, vest: 'none', pants: 2, tool: 'none', extra: 'none' };
function newsCrew() {
  if (!DAY || DAY.over || !document.getElementById('ov').hidden || WALK.busy) return;
  say(REPORTER, 'Channel 7 News', "We're covering the storm cleanup. What should homeowners know right now?", [
    { say: 'Take photos, call your insurance company yourself, and get a written estimate from a licensed local roofer. Never pay anyone up front.', act: function () {
      allHouses().forEach(function (x) { if (x.h.status === 'fresh') x.h.trust = Math.min(100, x.h.trust + 8); }); gain(30, 'Honest on the evening news'); stat('news');
      idle({ good: true, text: 'That clip ran all night. Every open door in town is a little warmer.' });
    } },
    { say: "Call us first. We'll handle your whole claim for you!", act: function () {
      DAY.clean = false; allHouses().forEach(function (x) { if (x.h.status === 'fresh') x.h.trust = Math.max(0, x.h.trust - 10); });
      idle({ bad: true, text: 'You just said the illegal line on live TV. In Kentucky, contractors do not handle claims.' });
    } },
  ]);
}

// ── Supplements: find what the scope missed; the homeowner sends it in ──
function supplement(h, a) {
  spend(AG_MIN.supplement); if (!DAY || DAY.over) return;
  if (!h.missing) h.missing = shuffle(SUPP_ITEMS.map(function (x) { return x.k; })).slice(0, 2 + rnd(2));
  var onScope = SUPP_ITEMS.filter(function (x) { return h.missing.indexOf(x.k) < 0; });
  var picked = {}, pre = h.missing.slice(0, sk('paper') + (SAVE.badges.anatomy ? 1 : 0));
  pre.forEach(function (k) { picked[k] = true; });
  var opts = shuffle(SUPP_ITEMS.map(function (x) { return { k: x.k, name: x.name }; }).concat(SUPP_PAD.map(function (p, i) { return { k: 'pad' + i, name: p, pad: true }; })));
  overlay('<h2>SUPPLEMENT · ' + esc(h.name.toUpperCase()) + '</h2><p class="help">Pat\'s scope sheet already pays for: ' + esc(onScope.map(function (x) { return x.name; }).join(', ')) + '. Tap only what the job really needs that the scope is <b>missing</b>.' + (pre.length ? ' Paperwork pro pre-flagged ' + pre.length + '.' : '') + '</p><div class="tools" id="sp"></div><div id="spF"></div><button type="button" class="btn primary wide" id="spGo">Build the packet</button>');
  var box = document.getElementById('sp');
  opts.forEach(function (o) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (picked[o.k] ? ' on' : ''); b.textContent = o.name; b.setAttribute('aria-pressed', String(!!picked[o.k]));
    b.addEventListener('click', function () { if (box.dataset.done) return; picked[o.k] = !picked[o.k]; b.classList.toggle('on', !!picked[o.k]); b.setAttribute('aria-pressed', String(!!picked[o.k])); });
    box.appendChild(b);
  });
  document.getElementById('spGo').addEventListener('click', function () {
    if (box.dataset.done) return; box.dataset.done = '1';
    var keys = Object.keys(picked).filter(function (k) { return picked[k]; });
    var pads = keys.filter(function (k) { return k.indexOf('pad') === 0; }), dup = keys.filter(function (k) { return k.indexOf('pad') !== 0 && h.missing.indexOf(k) < 0; });
    var got = SUPP_ITEMS.filter(function (x) { return h.missing.indexOf(x.k) >= 0 && picked[x.k]; });
    var missed = SUPP_ITEMS.filter(function (x) { return h.missing.indexOf(x.k) >= 0 && !picked[x.k]; });
    closeOverlay();
    if (pads.length || dup.length) {
      DAY.clean = false; h.supp = 0;
      return idle({ bad: true, text: 'Padding a supplement' + (dup.length ? ' (billing items the scope already pays for)' : '') + ' is insurance fraud. The carrier flagged it and denied the whole packet.' });
    }
    if (!got.length) return idle({ text: 'Nothing to send. The scope was missing ' + missed.map(function (x) { return x.name; }).join(', ') + '.' });
    var amt = got.reduce(function (t, x) { return t + x.amt; }, 0);
    say(h.look, h.name, 'You documented ' + got.length + ' missed item' + (got.length > 1 ? 's' : '') + ' (' + money(amt) + ') with photos and code references. How does it get to the insurer?', [
      { say: 'Hand the packet to ' + h.name + ' to send to their insurer. It\'s their claim.', act: function () {
        h.supp = amt; gain(10 + 8 * got.length, 'Supplement documented for ' + h.name); stat('supps');
        idle({ good: true, text: h.name + ' sends it in and the carrier approves ' + money(amt) + ' more. It\'s paid with the job, after the build.' + (missed.length ? ' Still missed: ' + missed.map(function (x) { return x.name + ' (' + x.why + ')'; }).join(' ') : '') });
      } },
      { say: 'Call the insurer yourself and push for the extra money.', act: function () {
        DAY.clean = false; h.supp = 0;
        idle({ bad: true, text: 'Negotiating with the insurer for the homeowner is public-adjuster work, and it\'s illegal for a Kentucky contractor. Give the homeowner the documentation; they send it.' });
      } },
    ]);
  });
}

// ── Phone calls: the job doesn't stop when you're between doors ──
function allHouses() { var out = []; Object.keys(SAVE.streets).forEach(function (sid) { SAVE.streets[sid].houses.forEach(function (h) { out.push({ sid: sid, h: h }); }); }); return out; }
function maybeRing() {
  if (DAY && !DAY.over && !DAY.heat && seasonFor(SAVE.day) === 'summer' && DAY.min >= 13 * 60 && Math.random() < 0.5) { DAY.heat = true; return setTimeout(heatCheck, 700); }
  if (!DAY || DAY.over || DAY.calls >= 3 || DAY.min > DAY.end - 30 || Math.random() > 0.16) return;
  DAY.calls++;
  setTimeout(function () { if (DAY && !DAY.over && document.getElementById('ov').hidden && !WALK.busy) ring(); }, 700);
}
function heatCheck() {
  if (!DAY || DAY.over || !document.getElementById('ov').hidden || WALK.busy) return;
  say(FOREMAN, 'Big Dave (foreman)', "It's 96 degrees on that roof and you've been up and down ladders since lunch.", [
    { say: 'Fifteen minutes in the shade with a water. Then back at it.', act: function () { spend(15); if (!DAY || DAY.over) return; gain(10, 'Heat safety break'); idle({ good: true, text: 'Smart. Heat exhaustion sneaks up on roofers every summer.' }); } },
    { say: "I'm fine. Push through.", act: function () { spend(45); if (!DAY || DAY.over) return; idle({ bad: true, text: 'You got dizzy on the ladder and had to sit in the truck for 45 minutes. Water and shade, every couple of hours.' }); } },
  ]);
}
function ring() {
  var H = allHouses(), ins = H.filter(function (x) { return (x.h.status === 'signed' || x.h.status === 'approved') && (x.h.damage === 'hail' || x.h.damage === 'some'); });
  var appr = H.filter(function (x) { return x.h.status === 'approved'; }), built = H.filter(function (x) { return x.h.status === 'built'; });
  var apprIns = appr.filter(function (x) { return x.h.damage === 'hail' || x.h.damage === 'some'; });
  var pool = ['spam'];
  if (ins.length) pool.push('desk', 'desk');
  if (apprIns.length) pool.push('check', 'check');
  if (appr.length) pool.push('supplier');
  if (built.length) pool.push('referral', 'referral');
  for (var nw = 0; nw < sk('networker'); nw++) if (built.length) pool.push('referral');
  var recent = H.filter(function (x) { return (x.h.status === 'signed' || x.h.status === 'approved') && !x.h.small && SAVE.day - x.h.since <= 2; });
  if (recent.length) pool.push('cancel');
  var mapleJobs = H.filter(function (x) { return x.sid === 'maple' && (x.h.status === 'approved' || x.h.status === 'building'); });
  if (mapleJobs.length) pool.push('hoaCall');
  var fresh2 = built.filter(function (x) { return SAVE.day - x.h.since <= 2; });
  if (fresh2.length) pool.push('nails');
  if (apprIns.length) pool.push('mortgage');
  var leakers = H.filter(function (x) { return (x.h.status === 'fresh' || x.h.status === 'later') && ['hail', 'some', 'repair'].indexOf(x.h.damage) >= 0 && ['empty', 'nosolicit', 'nightShift', 'renter'].indexOf(x.h.persona) < 0 && lvl() >= streetOf(x.sid).level; });
  if (leakers.length && (wet(DAY.wx) || Math.random() < 0.5)) pool.push('leak');
  var lows = SAVE.reviews.filter(function (r) { return r <= 3; }).length;
  if (lows > (SAVE.replied || 0)) pool.push('badreview', 'badreview');
  var kind = pick(pool), who, text, choices;
  if (kind === 'desk') {
    var d = pick(ins).h; who = 'Desk adjuster (the carrier)';
    text = "I'm working " + d.name + "'s claim. Off the record, what number would you settle at?";
    choices = [
      { say: "I don't settle claims. That's between you and " + d.name + ". I can give " + d.name + ' my estimate and photos to send you.', ok: true, xp: 15, fx: function () { d.trust = Math.min(100, d.trust + 5); }, why: 'Exactly right: the claim belongs to the homeowner.' },
      { say: 'Get me to a number and I\'ll make it work.', dirty: true, fx: function () { d.trust = Math.max(0, d.trust - 20); }, why: 'Settling a claim for the homeowner is public-adjuster work. Illegal for a Kentucky contractor.' },
    ];
  } else if (kind === 'check') {
    var c = pick(apprIns).h; who = c.name;
    text = 'The insurance check came, made out to me AND my mortgage company. What do I do?';
    choices = [
      { say: "That's normal. Your mortgage company endorses it too. We get paid when the work is done, not before.", ok: true, xp: 15, fx: function () { c.trust = Math.min(100, c.trust + 10); }, why: 'Calm, correct, and no money up front on a Kentucky insurance job.' },
      { say: 'Sign the check over to me today and I\'ll take it from there.', dirty: true, fx: function () { c.trust = Math.max(0, c.trust - 30); }, why: 'Never ask for a check signed over or an assignment of benefits. No money up front on Kentucky insurance jobs.' },
    ];
  } else if (kind === 'supplier') {
    var sp = pick(appr).h; who = 'Supply house';
    text = 'The shingle color ' + sp.name + ' picked is backordered two weeks.';
    choices = [
      { say: 'I\'ll call ' + sp.name + ' today with the in-stock colors and let them choose.', ok: true, xp: 10, fx: function () { sp.trust = Math.min(100, sp.trust + 10); }, why: 'Their roof, their choice. A heads-up call builds trust.' },
      { say: 'Just send whatever\'s close. They won\'t notice.', fx: function () { sp.trust = Math.max(0, sp.trust - 25); }, why: 'Homeowners always notice. Now you have an unhappy customer.' },
    ];
  } else if (kind === 'referral') {
    var r = pick(built).h; who = 'New number';
    text = 'Hi! My neighbor ' + r.name + ' said you were honest with them. Could you look at my roof?';
    var fresh = H.filter(function (x) { return x.h.status === 'fresh' && x.h.persona !== 'empty' && x.h.persona !== 'nosolicit' && lvl() >= streetOf(x.sid).level; });
    choices = [
      { say: 'Happy to. Does tomorrow work?', ok: true, xp: 20, fx: function () { if (!fresh.length) return; var n = pick(fresh); setStatus(n.h, 'booked'); n.h.trust = Math.max(n.h.trust, 65); n.h.referral = r.name; addAgenda('inspect', n.sid, n.h.i, SAVE.day + 1); }, why: fresh.length ? 'Booked from a referral. Happy customers are the best door hanger.' : 'Referral noted. Happy customers are the best door hanger.' },
      { say: "I'm slammed this week, call back later.", why: 'Never turn away a referral. That was a warm lead.' },
    ];
  } else if (kind === 'leak') {
    var lk = pick(leakers); who = lk.h.name;
    text = 'Water is coming through my ceiling! Can you help?';
    choices = [
      { say: "On my way. I'll tarp it today to stop the water, and we'll inspect properly when it's dry.", ok: true, xp: 20, mins: 30, why: 'Showing up in an emergency wins customers for life.', after: function () {
        gridGame({ title: 'Emergency tarp', help: 'Weigh the tarp down: tap every sandbag spot before the wind gets under it.', cols: 6, rows: 4, cell: 40, n: 6, seconds: 8, roof: '#2e5fa5', style: 'bag' }, function (found, n) {
          var good = found >= n - 1; setStatus(lk.h, 'booked'); lk.h.trust = Math.max(lk.h.trust, good ? 75 : 55); addAgenda('inspect', lk.sid, lk.h.i, SAVE.day + 1);
          gain(good ? 20 : 5, 'Emergency tarp at ' + lk.h.name + "'s"); stat('tarps');
          idle(good ? { good: true, text: 'Tarp held. ' + lk.h.name + " won't forget who showed up. The inspection is on tomorrow's list." } : { text: "One corner is flapping, but the water slowed. The inspection is on tomorrow's list." });
        });
      } },
      { say: "Call a plumber. That's not a roof thing.", fx: function () { lk.h.trust = Math.max(0, lk.h.trust - 15); }, why: 'Water through a ceiling after a storm is a roof thing.' },
    ];
  } else if (kind === 'cancel') {
    var cx = pick(recent).h; who = cx.name;
    text = "I've been thinking it over and I want to cancel. Is that going to be a problem?";
    choices = [
      { say: "Not at all. You have the right to cancel. I'll send written confirmation today, no hard feelings.", ok: true, xp: 15, fx: function () { if (Math.random() < 0.5) { cx.trust = Math.min(100, cx.trust + 20); toast(cx.name.toUpperCase() + ': ACTUALLY, LET\u2019S KEEP GOING'); } else { SAVE.agenda = SAVE.agenda.filter(function (a) { return !(a.i === cx.i && houseAt(a.sid, a.i) === cx); }); setStatus(cx, 'quiet'); } }, why: 'Respecting the right to cancel keeps your name clean, and sometimes it keeps the job too.' },
      { say: 'You signed a contract. Cancel and you owe us 20% today.', dirty: true, fx: function () { cx.trust = Math.max(0, cx.trust - 40); }, why: "Strong-arming a homeowner who's within their right to cancel is how complaints get filed. Never." },
    ];
  } else if (kind === 'hoaCall') {
    who = 'Maple Court HOA office'; text = 'Your dumpster is blocking the sidewalk on Maple Court.';
    choices = [
      { say: "Sorry about that. We'll move it today and put cones out.", ok: true, xp: 10, why: 'Fix it, say sorry, move on. The HOA remembers who was easy to work with.' },
      { say: 'Not my problem. Take it up with the homeowner.', fx: function () { mapleJobs.forEach(function (x) { x.h.trust = Math.max(0, x.h.trust - 15); }); }, why: "It's your dumpster. Now the homeowner is getting HOA letters because of you." },
    ];
  } else if (kind === 'nails') {
    var nb = pick(fresh2).h; who = 'Neighbor of ' + nb.name;
    text = 'I just picked up two roofing nails in my tire, right after your crew left.';
    choices = [
      { say: "I'm sorry. I'll come sweep your driveway today and cover the tire repair.", ok: true, xp: 15, fx: function () { ensureStreet(SAVE.streetId).houses.forEach(function (x) { if (x.status === 'fresh') x.trust = Math.min(100, x.trust + 5); }); }, why: 'Owning it turns an angry neighbor into a future customer.' },
      { say: "Prove they're ours.", why: "Even if you can't prove it, the whole street now thinks they were." },
    ];
  } else if (kind === 'mortgage') {
    var mg = pick(apprIns).h; who = "Mortgage company";
    text = 'We need an inspection before we release the insurance funds for ' + mg.name + "'s roof.";
    choices = [
      { say: "No problem. I'll send completion photos and the invoice to " + mg.name + ' and you, and you can inspect anytime.', ok: true, xp: 10, why: "The mortgage company is a co-payee. Make their job easy and the funds move." },
      { say: "Just release it. The job's basically done.", fx: function () { mg.trust = Math.max(0, mg.trust - 10); }, why: 'Basically done is not done. Funds release on completion, with proof.' },
    ];
  } else if (kind === 'badreview') {
    who = 'Review alert'; text = 'A customer just left you a low-star review.';
    choices = [
      { say: 'Reply publicly: own it, thank them, and offer to come make it right.', ok: true, xp: 15, fx: function () { SAVE.replied = (SAVE.replied || 0) + 1; }, why: 'Future customers read the reply more than the review.' },
      { say: 'Argue with them in the comments.', fx: function () { SAVE.replied = (SAVE.replied || 0) + 1; allHouses().forEach(function (x) { if (x.h.status === 'fresh') x.h.trust = Math.max(0, x.h.trust - 5); }); }, why: 'Arguing in public costs you every door that reads it.' },
    ];
  } else {
    who = 'Unknown caller'; text = "We've been trying to reach you about your truck's extended warranty…";
    choices = [
      { say: 'Hang up.', ok: true, xp: 1, why: 'Correct.' },
      { say: 'Press 1 to speak with an agent.', mins: 10, why: 'Ten minutes of hold music. Never again.' },
    ];
  }
  sfx('ring');
  overlay('<div class="call">📞</div><h2>INCOMING CALL</h2><div class="who">' + esc(who) + '</div><p>' + esc(text) + '</p><div class="choices" id="cc"></div><div id="ccF"></div>');
  var box = document.getElementById('cc');
  choices.forEach(function (ch) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = ch.say;
    b.addEventListener('click', function () {
      if (box.dataset.done) return; box.dataset.done = '1';
      if (ch.fx) ch.fx(); if (ch.dirty) DAY.clean = false; if (ch.ok && kind !== 'spam') stat('calls'); sfx(ch.ok ? 'good' : 'bad'); if (ch.xp) gain(ch.xp, 'Phone: ' + (kind === 'spam' ? 'dodged a robocall' : 'handled a call from ' + who));
      b.classList.add(ch.ok ? 'right' : 'wrong');
      document.getElementById('ccF').innerHTML = '<div class="tip ' + (ch.ok ? 'good' : 'bad') + '">' + esc(ch.why) + '</div><button type="button" class="btn primary wide" id="ccX">Hang up</button>';
      document.getElementById('ccX').addEventListener('click', function () { closeOverlay(); spend(5 + (ch.mins || 0)); renderToday(); hud(); if (ch.after && DAY && !DAY.over) ch.after(); });
    });
    box.appendChild(b);
  });
}

// ════════════════════════════════════════════════════════════════════════
// Training.
// ════════════════════════════════════════════════════════════════════════
function trainDone(key, passed, detail) {
  var first = passed && !SAVE.badges[key], again = passed && !first && SAVE.trained[key] !== SAVE.day;
  if (first) { SAVE.badges[key] = SAVE.day; SAVE.trained[key] = SAVE.day; gainAny(60, 'Earned the ' + COURSES[key].badge + ' badge'); }
  else if (again) { SAVE.trained[key] = SAVE.day; gainAny(15, 'Refresher: ' + COURSES[key].name); }
  else if (!DAY) persist();
  if (DAY) spend(20);
  overlay('<h2>' + (passed ? (first ? 'BADGE EARNED!' : 'PASSED') : 'NOT YET') + '</h2>' +
    '<p>' + esc(detail) + '</p>' +
    (first ? '<div class="tip good">' + esc(COURSES[key].badge) + ': ' + esc(COURSES[key].perk) + '</div>' : '') +
    (passed && !first && !again ? '<p class="help">Already refreshed today. Come back tomorrow for refresher XP.</p>' : '') +
    (!passed ? '<p class="help">Run it again; no penalty for practice.</p>' : '') +
    '<button type="button" class="btn primary wide" id="trOk">Back to training</button>');
  document.getElementById('trOk').addEventListener('click', function () { closeOverlay(); renderTrain(); });
}
function drawLadder(cv, feet) {
  var c = cv.getContext('2d'), u = 9, gy = 176, wx = 220, eave = gy - 16 * u;
  c.fillStyle = '#8ec5ff'; c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#356b31'; c.fillRect(0, gy, cv.width, cv.height - gy);
  c.fillStyle = '#c9b79c'; c.fillRect(wx, eave, 90, gy - eave);
  c.fillStyle = '#4a3f37'; c.fillRect(wx - 8, eave - 6, 100, 8);
  c.fillStyle = '#e8e2d4'; c.font = '8px "Press Start 2P", monospace'; c.textAlign = 'left'; c.fillText('16 FT', wx + 8, eave + 20);
  if (feet == null) return;
  var bx = wx - feet * u, len = Math.hypot(wx - bx, gy - eave), ext = 3 * u, dx = (wx - bx) / len, dy = (eave - gy) / len;
  var tx = wx + dx * ext, ty = eave + dy * ext;
  c.strokeStyle = '#b4b2a9'; c.lineWidth = 3; c.beginPath(); c.moveTo(bx - 3, gy); c.lineTo(tx - 3, ty); c.moveTo(bx + 3, gy); c.lineTo(tx + 3, ty); c.stroke();
  c.lineWidth = 2; for (var t = 0.08; t < 1; t += 0.09) { var x = bx + (tx - bx) * t, y = gy + (ty - gy) * t; c.beginPath(); c.moveTo(x - 3, y); c.lineTo(x + 3, y); c.stroke(); }
  c.fillStyle = '#f2a900'; c.fillText(feet + ' FT', bx - 10, gy + 14);
}
function ladderCourse() {
  var score = 0, qi = -1;
  overlay('<h2>LADDER SAFETY</h2><p>Step 1: the eave is 16 feet up. How far from the wall do you set the ladder\'s feet?</p><canvas class="mg" id="ld" width="320" height="200" aria-label="Ladder against a house"></canvas><div class="row" id="ldA"></div><div id="ldF"></div>');
  var cv = document.getElementById('ld'); drawLadder(cv, null);
  var A = document.getElementById('ldA');
  [2, 4, 7].forEach(function (ft) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = ft + ' feet';
    b.addEventListener('click', function () {
      if (A.dataset.done) return; A.dataset.done = '1'; drawLadder(cv, ft);
      var ok = ft === 4; if (ok) score++;
      b.classList.add(ok ? 'right' : 'wrong');
      var f = document.getElementById('ldF');
      f.innerHTML = '<div class="tip ' + (ok ? 'good' : 'bad') + '">' + (ok ? 'Right: the 4-to-1 rule.' : ft === 2 ? 'Too steep: it can tip backward.' : 'Too shallow: the feet can kick out.') + ' One foot out for every four feet up: 16 ÷ 4 = 4 feet.</div><button type="button" class="btn primary wide" id="ldN">Next</button>';
      document.getElementById('ldN').addEventListener('click', nextQ);
    });
    A.appendChild(b);
  });
  function nextQ() {
    qi++;
    if (qi >= LADDER_Q.length) return trainDone('ladder', score >= 5, 'You got ' + score + ' of ' + (LADDER_Q.length + 1) + '. Pass mark is 5.');
    var Q = LADDER_Q[qi];
    overlay('<h2>LADDER SAFETY · ' + (qi + 2) + '/' + (LADDER_Q.length + 1) + '</h2><p>' + esc(Q.q) + '</p><div class="choices" id="lq"></div><div id="lqF"></div>');
    var box = document.getElementById('lq');
    Q.a.forEach(function (ans, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = ans;
      b.addEventListener('click', function () {
        if (box.dataset.done) return; box.dataset.done = '1';
        var ok = i === Q.ok; if (ok) score++;
        b.classList.add(ok ? 'right' : 'wrong'); if (!ok) box.children[Q.ok].classList.add('right');
        document.getElementById('lqF').innerHTML = '<div class="tip ' + (ok ? 'good' : 'bad') + '">' + esc(Q.why) + '</div><button type="button" class="btn primary wide" id="lqN">Next</button>';
        document.getElementById('lqN').addEventListener('click', nextQ);
      });
      box.appendChild(b);
    });
  }
}
function toolsCourse() {
  var ji = 0, perfect = 0;
  round();
  function round() {
    if (ji >= TOOL_JOBS.length) return trainDone('tools', perfect >= 2, perfect + ' of ' + TOOL_JOBS.length + ' jobs packed perfectly. Pass mark is 2.');
    var J = TOOL_JOBS[ji], picked = {};
    overlay('<h2>RIGHT TOOL · ' + (ji + 1) + '/' + TOOL_JOBS.length + '</h2><p>The job: <b>' + esc(J.job) + '</b>. Tap everything you\'d take up the ladder, then check.</p><div class="tools" id="tl"></div><div id="tlF"></div><button type="button" class="btn primary wide" id="tlC">Check my tools</button>');
    var box = document.getElementById('tl');
    shuffle(TOOLS).forEach(function (t) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = t; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { if (box.dataset.done) return; picked[t] = !picked[t]; b.classList.toggle('on', picked[t]); b.setAttribute('aria-pressed', String(!!picked[t])); });
      box.appendChild(b);
    });
    document.getElementById('tlC').addEventListener('click', function () {
      if (box.dataset.done) { ji++; return round(); }
      box.dataset.done = '1';
      var missing = J.need.filter(function (t) { return !picked[t]; }), extra = Object.keys(picked).filter(function (t) { return picked[t] && J.need.indexOf(t) < 0; });
      Array.prototype.forEach.call(box.children, function (b) { var t = b.textContent; if (J.need.indexOf(t) >= 0) b.classList.add('right'); else if (picked[t]) b.classList.add('wrong'); });
      var ok = !missing.length && !extra.length; if (ok) perfect++;
      var notes = extra.map(function (t) { return t + ': ' + (TOOL_WHY[t] || 'not needed for this job.'); });
      document.getElementById('tlF').innerHTML = '<div class="tip ' + (ok ? 'good' : 'bad') + '">' + (ok ? 'Packed perfectly. ' : (missing.length ? 'Missing: ' + esc(missing.join(', ')) + '. ' : '') + esc(notes.join(' '))) + ' ' + esc(J.note) + '</div>';
      document.getElementById('tlC').textContent = ji + 1 < TOOL_JOBS.length ? 'Next job' : 'Finish';
    });
  }
}
function walkCourse() {
  var next = 0, misses = 0;
  overlay('<h2>JOB WALKTHROUGH</h2><p>A full roof replacement, start to finish. Tap the steps in order.</p><div class="steps" id="ws"></div><p class="help" id="wsF">Mistakes: 0 (pass with 2 or fewer)</p>');
  var box = document.getElementById('ws');
  shuffle(WALK_STEPS.map(function (s, i) { return { s: s, i: i }; })).forEach(function (st) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = st.s;
    b.addEventListener('click', function () {
      if (b.dataset.used) return;
      if (st.i === next) {
        b.dataset.used = '1'; b.classList.add('right'); b.textContent = (next + 1) + '. ' + st.s; next++;
        box.appendChild(b);
        Array.prototype.slice.call(box.children).filter(function (x) { return !x.dataset.used; }).forEach(function (x) { box.appendChild(x); });
        if (next === WALK_STEPS.length) setTimeout(function () { trainDone('walk', misses <= 2, 'All ' + WALK_STEPS.length + ' steps in order with ' + misses + ' mistake' + (misses === 1 ? '' : 's') + '.'); }, 350);
      } else {
        misses++; b.classList.add('wrong'); setTimeout(function () { b.classList.remove('wrong'); }, 450);
        document.getElementById('wsF').textContent = 'Mistakes: ' + misses + ' (pass with 2 or fewer). Not yet: what comes before that?';
      }
    });
    box.appendChild(b);
  });
}
var LAW_Q = [
  { q: 'Can a contractor negotiate an insurance claim for the homeowner in Kentucky?', a: ['Yes, if the homeowner asks', 'No. Only the homeowner or a licensed public adjuster', 'Only on claims over $10,000'], ok: 1, why: 'Contractors document and estimate. The claim belongs to the homeowner.' },
  { q: "Can you pay or waive the homeowner's deductible?", a: ['No', 'Yes, as a discount', 'Only for repeat customers'], ok: 0, why: 'The deductible is the homeowner\u2019s by law. Covering it is fraud.' },
  { q: 'On an insurance job, when do you get paid?', a: ['A deposit when they sign', 'When the insurance check arrives, before work', 'When the work is done, no money up front'], ok: 2, why: 'No advance payment on Kentucky insurance jobs.' },
  { q: 'Can your contract include an assignment of benefits?', a: ['Yes, it is standard', 'No. The homeowner keeps their claim', 'Only with a notary'], ok: 1, why: 'No AOB. The homeowner stays in control of their own claim.' },
  { q: 'Can you go to the adjuster meeting?', a: ['Yes, at the homeowner\u2019s request, to show your documentation', 'Yes, to negotiate the settlement', 'Never'], ok: 0, why: 'Attend, show your photos and measurements, and let the homeowner own the claim.' },
  { q: 'A $500 gift card for signing with you?', a: ['Great marketing', 'No. Gifts to the insured are capped at $100', 'Only during storm season'], ok: 1, why: 'Kentucky caps what you can give an insured homeowner.' },
];
var MEASURE_Q = [
  { q: 'A flat roof plane is 40 ft by 20 ft. How many squares?', a: ['4', '8', '80'], ok: 1, why: '800 square feet ÷ 100 = 8 squares.' },
  { q: 'Same plane at a 6/12 pitch (pitch factor 1.118). About how many squares?', a: ['8', '8.9', '11.2'], ok: 1, why: '8 × 1.118 ≈ 8.9 squares.' },
  { q: 'Add 10% waste to 20 squares. How many do you order?', a: ['20', '21', '22'], ok: 2, why: '20 × 1.10 = 22 squares.' },
  { q: 'A roof rises 8 inches for every 12 inches of run. That is…', a: ['An 8/12 pitch', 'A 12/8 pitch', 'An 8-degree pitch'], ok: 0, why: 'Rise over a 12-inch run.' },
  { q: 'Same footprint: which needs more shingles, a 4/12 or a 10/12 roof?', a: ['4/12', '10/12', 'The same'], ok: 1, why: 'Steeper roofs have more surface over the same footprint.' },
];
var ANATOMY = [
  { part: 'ridge', ok: 'Ridge', why: 'The peak where two slopes meet. It gets ridge cap.' },
  { part: 'eave', ok: 'Eave', why: 'The bottom edge where water runs off into the gutter.' },
  { part: 'rake', ok: 'Rake', why: 'The sloped edge at a gable end.' },
  { part: 'valley', ok: 'Valley', why: 'Where two slopes meet in a trough. It carries the most water.' },
  { part: 'flashing', ok: 'Step flashing', why: 'Metal that turns water where the roof meets a wall or chimney.' },
  { part: 'boot', ok: 'Pipe boot', why: 'The rubber collar sealing a plumbing vent.' },
];
var ANATOMY_NAMES = ['Ridge', 'Eave', 'Rake', 'Valley', 'Step flashing', 'Pipe boot', 'Soffit', 'Fascia'];
function drawAnatomy(cv, part) {
  var c = cv.getContext('2d'), hl = '#f2a900';
  c.fillStyle = '#8ec5ff'; c.fillRect(0, 0, 320, 180);
  c.fillStyle = '#356b31'; c.fillRect(0, 160, 320, 20);
  c.fillStyle = '#d6c6a8'; c.fillRect(60, 100, 200, 60);
  c.fillStyle = '#4a4f5a'; c.beginPath(); c.moveTo(40, 100); c.lineTo(160, 30); c.lineTo(280, 100); c.closePath(); c.fill();
  c.fillStyle = '#5a606c'; c.beginPath(); c.moveTo(150, 100); c.lineTo(205, 62); c.lineTo(260, 100); c.closePath(); c.fill();
  c.fillStyle = '#9e4a36'; c.fillRect(90, 46, 16, 34);
  c.fillStyle = '#2c2c2a'; c.fillRect(200, 78, 5, 9);
  var line = function (x1, y1, x2, y2) { c.strokeStyle = hl; c.lineWidth = 5; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); };
  if (part === 'ridge') { c.fillStyle = hl; c.fillRect(150, 26, 20, 8); }
  if (part === 'eave') line(40, 101, 280, 101);
  if (part === 'rake') line(40, 100, 160, 30);
  if (part === 'valley') line(150, 100, 205, 62);
  if (part === 'flashing') { line(88, 80, 108, 80); line(106, 50, 106, 80); }
  if (part === 'boot') { c.strokeStyle = hl; c.lineWidth = 3; c.strokeRect(196, 74, 13, 15); }
}
function quizCourse(key, title, qs, pass, draw) {
  var score = 0, qi = -1;
  next();
  function next() {
    qi++;
    if (qi >= qs.length) return trainDone(key, score >= pass, 'You got ' + score + ' of ' + qs.length + '. Pass mark is ' + pass + '.');
    var Q = qs[qi];
    overlay('<h2>' + esc(title) + ' · ' + (qi + 1) + '/' + qs.length + '</h2>' + (draw ? '<canvas class="mg" id="qc" width="320" height="180" aria-label="Roof diagram"></canvas>' : '') + '<p>' + esc(Q.q) + '</p><div class="choices" id="qq"></div><div id="qF"></div>');
    if (draw) draw(document.getElementById('qc'), Q);
    var box = document.getElementById('qq');
    Q.a.forEach(function (ans, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = ans;
      b.addEventListener('click', function () {
        if (box.dataset.done) return; box.dataset.done = '1';
        var ok = i === Q.ok; if (ok) score++;
        sfx(ok ? 'good' : 'bad');
        b.classList.add(ok ? 'right' : 'wrong'); if (!ok) box.children[Q.ok].classList.add('right');
        document.getElementById('qF').innerHTML = '<div class="tip ' + (ok ? 'good' : 'bad') + '">' + esc(Q.why) + '</div><button type="button" class="btn primary wide" id="qN">Next</button>';
        document.getElementById('qN').addEventListener('click', next);
      });
      box.appendChild(b);
    });
  }
}
function anatomyCourse() {
  var qs = shuffle(ANATOMY).map(function (A) {
    var opts = shuffle([A.ok].concat(shuffle(ANATOMY_NAMES.filter(function (n) { return n !== A.ok; })).slice(0, 2)));
    return { q: 'What is the highlighted part called?', a: opts, ok: opts.indexOf(A.ok), why: A.why, part: A.part };
  });
  quizCourse('anatomy', 'ROOF ANATOMY', qs, 5, function (cv, Q) { drawAnatomy(cv, Q.part); });
}
function renderTrain() {
  var el = document.getElementById('p-train');
  var html = '<div class="card"><h2>TRAINING YARD</h2><p class="help">Short courses with Big Dave, your foreman. Pass one to earn its badge and a perk on the job. Refreshers pay a little XP once a day.' + (DAY ? ' Each course takes 20 minutes of your work day.' : ' Train before you clock in, or anytime.') + '</p></div>';
  Object.keys(COURSES).forEach(function (k) {
    var C2 = COURSES[k], has = SAVE.badges[k];
    html += '<div class="card' + (has ? '' : ' hl') + '"><h3>' + esc(C2.name.toUpperCase()) + '</h3>' +
      '<p class="help">' + (has ? '<span class="badge-ok">✓ ' + esc(C2.badge) + '</span> · ' : 'Badge: ' + esc(C2.badge) + ' · ') + esc(C2.perk) + '</p>' +
      '<button type="button" class="btn primary" data-course="' + k + '">' + (has ? 'Refresher' : 'Start course') + '</button></div>';
  });
  el.innerHTML = html;
  el.querySelectorAll('[data-course]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.dataset.course;
      say(FOREMAN, 'Big Dave (foreman)', { ladder: 'Most roof injuries start at the ladder, not the roof. Let\'s get it right.', tools: 'Pack right and you climb once. Pack wrong and you climb all day.', walk: 'If you can explain the job, the homeowner can trust the job.', law: 'Know the rules cold and nobody can trap you on a porch.', anatomy: 'You can\'t document what you can\'t name.', measure: 'Bad numbers lose jobs and lose money. Measure twice.' }[k], []);
      ({ ladder: ladderCourse, tools: toolsCourse, walk: walkCourse, law: function () { quizCourse('law', 'KENTUCKY RULES', shuffle(LAW_Q), 5); }, anatomy: anatomyCourse, measure: function () { quizCourse('measure', 'MEASURING', MEASURE_Q, 4); } })[k]();
    });
  });
}

// ════════════════════════════════════════════════════════════════════════
// Panels.
// ════════════════════════════════════════════════════════════════════════
function hud() {
  var L = levelFor(SAVE.xp);
  document.getElementById('hDay').textContent = SAVE.day + ' ' + SEASON[seasonFor(SAVE.day)].icon;
  document.getElementById('hTime').textContent = DAY ? clock(Math.min(DAY.min, DAY.end)) + ' ' + WX[DAY.wx].icon : 'Morning';
  var spf = spFree(), lk = document.getElementById('lkBadge'); lk.hidden = spf <= 0; lk.textContent = spf;
  document.getElementById('hXp').textContent = DAY ? DAY.xp : 0;
  document.getElementById('hSigned').textContent = DAY ? DAY.signed : 0;
  document.getElementById('hColl').textContent = money(SAVE.collected);
  document.getElementById('lvlText').textContent = 'Level ' + L.level + ' · ' + L.title + ' · ' + SAVE.xp.toLocaleString('en-US') + ' / ' + L.next.toLocaleString('en-US') + ' XP';
  var pct = Math.round((SAVE.xp - L.floor) / (L.next - L.floor) * 100);
  document.getElementById('lvlFill').style.width = pct + '%';
  document.getElementById('lvlBar').setAttribute('aria-valuenow', pct);
  var due = agendaDue(SAVE.day).length, bd = document.getElementById('agBadge');
  bd.hidden = !due; bd.textContent = due;
}
function renderChips() {
  var el = document.getElementById('streetChips'); el.innerHTML = '';
  STREETS.forEach(function (s) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    var open = lvl() >= s.level;
    b.textContent = open ? s.name : s.name + ' · Lv ' + s.level;
    b.disabled = !open; b.setAttribute('aria-pressed', String(s.id === SAVE.streetId));
    b.addEventListener('click', function () { if (s.id === SAVE.streetId || WALK.busy) return; goToStreet(s); });
    el.appendChild(b);
  });
}
function renderToday() {
  var el = document.getElementById('p-today'), html = '';
  if (!DAY) {
    var plan = morningPlan(), lines = [];
    if (SAVE.day === 1 && SAVE.xp === 0) lines.push('Last night\'s hail hit Maple Court. Knock smart, inspect honestly, close clean. New? Hit the Train tab first.');
    plan.builds.forEach(function (b) { lines.push('Build day at ' + b.h.name + '\'s. You collect ' + money(b.h.price + (b.h.supp || 0)) + ' when the roof is done.'); });
    if (plan.party) lines.push('🎈 Block party on ' + streetOf(SAVE.streetId).name + ' today. Everyone is outside and friendly (+10 trust).');
    if (plan.short) lines.push('📦 Supply shortage: the shingle truck didn\'t come. No builds today.');
    if (plan.cat) lines.push('🌪 CATASTROPHE STORM overnight. Every street got hail, and out-of-state chasers are flooding town. Big week; stay clean.');
    if (plan.storm) lines.push('⛈ A storm rolled through ' + plan.storm.name + ' overnight. Fresh damage on open doors.');
    if (plan.newSeason || SAVE.day === 1) lines.push(SEASON[plan.season].icon + ' ' + SEASON[plan.season].name + ' is here. ' + SEASON[plan.season].note);
    if (plan.unsched) lines.push(plan.unsched + ' approved job' + (plan.unsched > 1 ? 's are' : ' is') + ' waiting on a build date. Homeowners get antsy.');
    if (plan.small.length) lines.push('The repair tech finishes ' + plan.small.map(function (b) { return b.h.name; }).join(' and ') + ' this morning.');
    if (plan.wx !== 'sun') lines.push(WX[plan.wx].icon + ' ' + WX[plan.wx].name + ' today.' + (wet(plan.wx) ? ' No climbing; builds wait a day.' : ''));
    if (plan.waiting.length && !wet(plan.wx)) lines.push(plan.waiting.length + ' approved build' + (plan.waiting.length > 1 ? 's are' : ' is') + ' waiting on a crew. A second crew would help.');
    if (spFree() > 0) lines.push('You have ' + spFree() + ' skill point' + (spFree() > 1 ? 's' : '') + ' to spend in the Locker.');
    if (plan.reopen) lines.push(plan.reopen + ' door' + (plan.reopen > 1 ? 's' : '') + ' you knocked before are worth another try.');
    var due = agendaDue(SAVE.day).length;
    if (due) lines.push(due + ' thing' + (due > 1 ? 's' : '') + ' you said you\'d do today.');
    html += '<div class="card hl"><h2>DAY ' + SAVE.day + ' · MORNING</h2>' + (lines.length ? '<ul class="report">' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' : '<p class="help">A quiet morning. Good day to knock.</p>') +
      '<button type="button" class="btn primary wide" id="startBtn">Start day ' + SAVE.day + '</button></div>';
  }
  html += '<div class="card"><h3>FORECAST</h3><div class="fc">' + [0, 1, 2].map(function (o) { var w = WX[weatherFor(SAVE.day + o)]; return '<div><small>' + (o === 0 ? 'Today' : 'Day ' + (SAVE.day + o)) + '</small><b>' + w.icon + '</b><small>' + w.name + '</small></div>'; }).join('') + '</div><p class="help">Rain: no climbing, builds wait. Wind: short inspections without the ladder badge or a drone. ' + (owns('crew2') ? 'Two crews: 2 builds a day.' : 'One crew: 1 build a day.') + '</p></div>';
  var items = SAVE.agenda.slice().sort(function (a, b) { return a.due - b.due; });
  html += '<div class="card"><h2>SAID YOU\'D DO</h2>';
  if (!items.length) html += '<p class="help">Nothing yet. Book inspections and leave estimates, and they land here.</p>';
  items.forEach(function (a) {
    var lb = agendaLabel(a), ready = DAY && a.due <= SAVE.day;
    html += '<div class="item"><div class="d">' + esc(lb.t) + '<small>' + esc(lb.s) + (a.due > SAVE.day ? ' · day ' + a.due : '') + '</small></div>' +
      (ready ? '<button type="button" class="btn" data-ag="' + a.id + '">Go · ' + AG_MIN[a.type] + 'm</button>' : '') + '</div>';
  });
  html += '</div>';
  html = challengeHtml() + html;
  html += crewBoardHtml();
  var bld = [];
  Object.keys(SAVE.streets).forEach(function (sid) { SAVE.streets[sid].houses.forEach(function (h) { if (false) bld.push(h.name + ' · build day ' + h.buildDay + ' · ' + money(h.price)); }); });
  if (bld.length) html += '<div class="card"><h3>ON THE BUILD CALENDAR</h3><ul class="report">' + bld.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul></div>';
  var nb = Object.keys(SAVE.badges).length;
  html += '<div class="card"><h3>CAREER</h3><div class="grid-sum"><span>Days worked</span><b>' + (SAVE.day - 1) + '</b><span>Sold (retail)</span><b>' + money(SAVE.sold) + '</b><span>Collected</span><b>' + money(SAVE.collected) + '</b><span>Best day</span><b>' + SAVE.bestDay + ' XP</b><span>Clean days</span><b>' + SAVE.cleanDays + '</b><span>Bank</span><b>' + money(SAVE.bank) + '</b><span>Reviews</span><b>' + (SAVE.reviews.length ? repStars().toFixed(1) + '★ (' + SAVE.reviews.length + ')' : '—') + '</b><span>Badges</span><b>' + nb + ' / 3</b></div>' +
    '<div class="row"><button type="button" class="btn" id="howBtn">How to play</button><button type="button" class="btn" id="resetBtn">Start a new career</button></div></div>';
  el.innerHTML = html;
  var sb = document.getElementById('startBtn'); if (sb) sb.addEventListener('click', startDay);
  el.querySelectorAll('[data-sched]').forEach(function (b) { b.addEventListener('click', function () { var p2 = b.dataset.sched.split(':'); schedulePicker(p2[0], Number(p2[1])); }); });
  el.querySelectorAll('[data-ag]').forEach(function (b) { b.addEventListener('click', function () { var a = SAVE.agenda.filter(function (x) { return String(x.id) === b.dataset.ag; })[0]; if (a) runAgenda(a); }); });
  document.getElementById('howBtn').addEventListener('click', function () { tutorial(0); });
  document.getElementById('resetBtn').addEventListener('click', function () {
    overlay('<h2>NEW CAREER?</h2><p>This wipes your days, XP, badges and streets. Your look stays.</p><div class="row"><button type="button" class="btn primary" id="rsYes">Start over</button><button type="button" class="btn" id="rsNo">Keep my career</button></div>');
    document.getElementById('rsYes').addEventListener('click', function () { var av = SAVE.avatar; SAVE = freshSave(); SAVE.avatar = av; SAVE.tutored = true; DAY = null; ensureStreet('maple'); persist(); closeOverlay(); renderAll(); showTab('today'); });
    document.getElementById('rsNo').addEventListener('click', closeOverlay);
  });
}
var avatarTimer = null;
function renderLocker() {
  var el = document.getElementById('p-locker'), a = normalize(SAVE.avatar), L = lvl();
  el.innerHTML = skillsHtml() + shopHtml() + '<div class="card"><h2>YOUR LOOK</h2><p class="help">Your rep, your look. Some gear unlocks as you level up. Your look also shows on the crew board.</p>' +
    '<div class="locker"><canvas id="lkPrev" width="256" height="256" role="img" aria-label="Your rep"></canvas><div class="opts" id="lkOpts"></div></div></div>';
  var opts = document.getElementById('lkOpts');
  Object.keys(OPTIONS).forEach(function (k) {
    var o = OPTIONS[k], grp = document.createElement('div');
    var lb = document.createElement('div'); lb.className = 'lbl'; lb.textContent = o.label; grp.appendChild(lb);
    var wrap = document.createElement('div'); wrap.className = 'sw';
    (o.colors || o.values).forEach(function (v, i) {
      var val = o.colors ? i : v[0], need = LOCKS[k + ':' + val] || 0;
      var b = document.createElement('button'); b.type = 'button';
      if (o.colors) { b.className = 'swatch'; b.style.background = v; b.setAttribute('aria-label', o.label + ' ' + (i + 1) + (need > L ? ' (unlocks at level ' + need + ')' : '')); if (need > L) { b.disabled = true; b.title = 'Unlocks at level ' + need; } }
      else { b.className = 'opt'; b.textContent = need > L ? v[1] + ' · Lv ' + need : v[1]; b.disabled = need > L; }
      b.setAttribute('aria-pressed', String(a[k] === val));
      b.addEventListener('click', function () {
        var na = normalize(SAVE.avatar); na[k] = val; SAVE.avatar = na;
        saveLocal(); renderLocker(); drawTo(document.getElementById('meFace'), SAVE.avatar);
        clearTimeout(avatarTimer); avatarTimer = setTimeout(persist, 1200);
      });
      wrap.appendChild(b);
    });
    grp.appendChild(wrap); opts.appendChild(grp);
  });
  drawTo(document.getElementById('lkPrev'), SAVE.avatar);
  el.querySelectorAll('[data-skill]').forEach(function (b) { b.addEventListener('click', function () {
    var k = b.dataset.skill; if (spFree() <= 0 || sk(k) >= 3) return;
    SAVE.skills[k] = sk(k) + 1; if (!DAY) persist(); else saveLocal(); toast(SKILLS[k].name.toUpperCase() + ' RANK ' + SAVE.skills[k]); renderLocker(); hud();
  }); });
  el.querySelectorAll('[data-buy]').forEach(function (b) { b.addEventListener('click', function () {
    var it = SHOP.filter(function (x) { return x.id === b.dataset.buy; })[0]; if (!it || owns(it.id) || SAVE.bank < it.price) return;
    SAVE.bank -= it.price; SAVE.owned[it.id] = SAVE.day; if (!DAY) persist(); else saveLocal(); toast('BOUGHT: ' + it.name.toUpperCase()); renderLocker(); hud();
  }); });
}
function skillsHtml() {
  var free = spFree();
  return '<div class="card' + (free > 0 ? ' hl' : '') + '"><h2>SKILLS</h2><p class="help">One point per level. ' + (free > 0 ? '<b>' + free + ' point' + (free > 1 ? 's' : '') + ' to spend.</b>' : 'Level up to earn more.') + '</p>' +
    Object.keys(SKILLS).map(function (k) {
      var r = sk(k);
      return '<div class="skill"><div class="d">' + esc(SKILLS[k].name) + ' <span class="pips">' + '■'.repeat(r) + '□'.repeat(3 - r) + '</span><small>' + esc(SKILLS[k].what) + '</small></div>' +
        (r < 3 ? '<button type="button" class="btn" data-skill="' + k + '"' + (free > 0 ? '' : ' disabled') + '>+1</button>' : '<span class="badge-ok">MAX</span>') + '</div>';
    }).join('') + '</div>';
}
function shopHtml() {
  return '<div class="card"><h2>UPGRADES · BANK ' + money(SAVE.bank) + '</h2><p class="help">Reinvest money you\'ve collected from finished roofs. Sold doesn\'t count until it\'s collected.</p>' +
    SHOP.map(function (it) {
      var has = owns(it.id);
      return '<div class="skill"><div class="d">' + esc(it.name) + '<small>' + esc(it.what) + '</small></div>' +
        (has ? '<span class="badge-ok">OWNED</span>' : '<button type="button" class="btn" data-buy="' + it.id + '"' + (SAVE.bank >= it.price ? '' : ' disabled') + '>' + money(it.price) + '</button>') + '</div>';
    }).join('') + '</div>';
}
var crewSeq = 0;
async function renderCrew() {
  var el = document.getElementById('p-crew'), wk = weekKey(), seq = ++crewSeq;
  var online = !!NET.uid;
  var rows = online ? NET.scores.slice() : [];
  if (!online || !rows.some(function (r) { return r.id === NET.uid; })) {
    var L = levelFor(SAVE.xp);
    rows.push({ id: online ? NET.uid : 'me', name: (NET.net && NET.net.name) || '', xp: SAVE.xp, level: L.level, title: L.title, weekKey: SAVE.weekKey, weekXp: SAVE.weekXp, bestDay: SAVE.bestDay, days: SAVE.day - 1, avatar: SAVE.avatar });
  }
  rows.forEach(function (r) { r.wk = r.weekKey === wk ? (r.weekXp || 0) : 0; });
  rows.sort(function (a, b) { return b.wk - a.wk || (b.xp || 0) - (a.xp || 0); });
  var names = {};
  rows.forEach(function (r) { names[r.id] = { name: r.name || '' }; });
  if (seq !== crewSeq) return;
  el.innerHTML = '<div class="card"><h2>CREW BOARD · THIS WEEK</h2><p class="help">Ranked by XP earned this week (resets Monday). Everyone on your NBD Pro team shows up once they play a day.</p>' +
    '<table class="lb"><thead><tr><th></th><th>Rep</th><th class="num">Week</th><th class="num hide-sm">Best day</th><th class="num hide-sm">Days</th></tr></thead><tbody id="lbBody"></tbody></table>' +
    (!online ? '<p class="help">Sign in to NBD Pro to see your team\'s board. For now it\'s just you.</p>' : '') + '</div>';
  el.insertAdjacentHTML('beforeend', trophiesHtml());
  var body = document.getElementById('lbBody');
  rows.forEach(function (r, i) {
    var tr = document.createElement('tr'), me = r.id === 'me' || r.id === NET.uid; if (me) tr.className = 'me';
    var td0 = document.createElement('td'); td0.className = 'rk'; td0.textContent = i + 1; tr.appendChild(td0);
    var td1 = document.createElement('td'), w = document.createElement('div'); w.className = 'who2';
    var cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; drawTo(cv, r.avatar || DEFAULTS); w.appendChild(cv);
    var nm = document.createElement('div'), p = names[r.id];
    nm.textContent = me ? (p && p.name ? p.name + ' (you)' : 'You') : (p && p.name) || 'A rep';
    var sm = document.createElement('small'); sm.textContent = 'Lv ' + (r.level || 1) + ' · ' + (r.title || 'Apprentice'); nm.appendChild(sm);
    w.appendChild(nm); td1.appendChild(w); tr.appendChild(td1);
    [[r.wk + ' XP', ''], [(r.bestDay || 0) + ' XP', ' hide-sm'], [String(r.days || 0), ' hide-sm']].forEach(function (c) { var td = document.createElement('td'); td.className = 'num' + c[1]; td.textContent = c[0]; tr.appendChild(td); });
    body.appendChild(tr);
  });
}
function renderAll() { hud(); renderChips(); renderToday(); renderTrain(); renderLocker(); renderCrew(); drawTo(document.getElementById('meFace'), SAVE.avatar); }
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === name)); });
  ['street', 'today', 'train', 'locker', 'crew'].forEach(function (t) { document.getElementById('p-' + t).hidden = t !== name; });
  if (name === 'today') renderToday();
  if (name === 'train') renderTrain();
  if (name === 'crew') renderCrew();
  if (name === 'street' && !DAY) idle();
}
function overlay(html) { document.getElementById('ovCard').innerHTML = html; document.getElementById('ov').hidden = false; var f = document.querySelector('#ovCard button'); if (f) f.focus({ preventScroll: true }); }
function closeOverlay() { document.getElementById('ov').hidden = true; }
var toastT = null;
function toast(t) { var el = document.getElementById('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { el.hidden = true; }, 4200); }

// ── First-day tutorial ──
var TUTORIAL = [
  { t: 'WELCOME TO THE CREW', p: "I'm Big Dave, your foreman. Hail hit town last night. Your job: knock doors, find real damage, and close clean. Here's how a day works." },
  { t: 'THE STREET', p: 'Tap a house to walk to its door. Dark specks on a roof mean hail. Every knock and every line you say costs clock time, and the day ends at 6 PM. Tap another street to drive there; watch the traffic.' },
  { t: 'AT THE DOOR', p: "Read the homeowner. Honest, specific answers build trust. Some answers lose the house on the spot, and Kentucky law is the trap: never say you'll handle their claim, never touch the deductible, and no money up front on insurance jobs." },
  { t: 'YOUR TODAY LIST', p: "Booked inspections, follow-ups, adjuster meetings, supplements and build days land on your Today list. Pick build days on the crew board around the weather. Sold isn't collected: you get paid when the roof is done." },
  { t: 'LEVEL UP', p: "XP unlocks new streets, skills and gear in the Locker. Train with me first in the Train tab; every badge helps on the job. At 6 PM, log your leads in the CRM. Ready? Start day 1 from the Today tab." },
];
function tutorial(i) {
  i = i || 0;
  var T = TUTORIAL[i], last = i === TUTORIAL.length - 1;
  overlay('<h2>' + esc(T.t) + '</h2><div class="tut"><canvas id="tutFace" width="32" height="32" aria-hidden="true"></canvas><p>' + esc(T.p) + '</p></div>' +
    '<div class="dots">' + TUTORIAL.map(function (_, k) { return '<i' + (k === i ? ' class="on"' : '') + '></i>'; }).join('') + '</div>' +
    '<div class="row"><button type="button" class="btn primary grow" id="tutN">' + (last ? "Let's go" : 'Next') + '</button>' + (last ? '' : '<button type="button" class="btn" id="tutS">Skip</button>') + '</div>');
  drawTo(document.getElementById('tutFace'), FOREMAN);
  var end = function () { SAVE.tutored = true; saveLocal(); closeOverlay(); showTab('today'); };
  document.getElementById('tutN').addEventListener('click', function () { if (last) end(); else tutorial(i + 1); });
  var sk2 = document.getElementById('tutS'); if (sk2) sk2.addEventListener('click', end);
}

// ── Input ──
(function () {
  var b = document.getElementById('sndBtn');
  function paintSnd() { b.textContent = SND.on ? '🔊' : '🔇'; b.setAttribute('aria-label', SND.on ? 'Sound on' : 'Sound off'); }
  paintSnd();
  b.addEventListener('click', function () { SND.on = !SND.on; try { localStorage.setItem('roofrep.sound', SND.on ? 'on' : 'off'); } catch (_) {} paintSnd(); if (SND.on) sfx('good'); });
})();
document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
W.addEventListener('click', function (e) {
  if (!DAY) { idle(); return; }
  var b = W.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * 320, y = (e.clientY - b.top) / b.height * 200;
  var hit = ensureStreet(SAVE.streetId).houses.filter(function (h) { var hy = h.top ? 8 : 116; return x >= h.x - 4 && x <= h.x + 84 && y >= hy && y <= hy + 76; })[0];
  if (hit) walkTo(hit);
});
document.getElementById('endBtn').addEventListener('click', function () {
  if (!DAY || DAY.over) return;
  overlay('<h2>CALL IT A DAY?</h2><p>It\'s ' + clock(DAY.min) + '. Anything left on your list carries to tomorrow.</p><div class="row"><button type="button" class="btn primary" id="edYes">End the day</button><button type="button" class="btn" id="edNo">Keep knocking</button></div>');
  document.getElementById('edYes').addEventListener('click', function () { closeOverlay(); endDay(); });
  document.getElementById('edNo').addEventListener('click', closeOverlay);
});

// ── Boot ──
SAVE = loadLocal() || freshSave();
ensureStreet(SAVE.streetId);
renderAll(); showTab('today'); tick();
if (!SAVE.tutored && SAVE.day === 1 && SAVE.xp === 0) setTimeout(function () { tutorial(0); }, 300);
connect();
