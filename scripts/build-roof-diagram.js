// scripts/build-roof-diagram.js — generates docs/assets/images/roof-layers.svg,
// the static gable-roof cutaway (every code item labelled) that
// /services/roof-replacement shows before (and instead of) the 3D view.
//   node scripts/build-roof-diagram.js            # rewrite the SVG
// Edit the callouts / geometry here, never the SVG by hand. Oblique projection: front roof plane P(u,v), u along the
// eave (0..1), v up the slope (0..1). The right end is the gable.
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || path.join(__dirname, '..', 'docs', 'assets', 'images', 'roof-layers.svg');

const W = 1200, H = 620;
const E0 = [390, 340], EU = [420, 0], EV = [60, -150];
const D = [120, -70];                                   // house depth (ridge sits at D/2)
const P = (u, v) => [E0[0] + EU[0] * u + EV[0] * v, E0[1] + EU[1] * u + EV[1] * v];
const f1 = (n) => Math.round(n * 10) / 10;
const pts = (...ps) => ps.map((p) => f1(p[0]) + ',' + f1(p[1])).join(' ');
const quad = (u0, u1, v0, v1) => pts(P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1));
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const line = (a, b, stroke, w) => `  <line x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}" stroke="${stroke}" stroke-width="${w}"/>\n`;

const A = P(0, 0), B = P(1, 0), R1 = P(0, 1), R2 = P(1, 1);
const BACK = add(B, D);
const WALL_H = 140;
const METAL = 'fill="#b8bec7" stroke="#8e96a1" stroke-width="1"';

let s = '';
s += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">\n`;
s += `  <title id="t">A code-correct NBD gable roof, cut away layer by layer</title>\n`;
s += `  <desc id="d">A gable roof with its layers cut away: the wood roof deck, with rotted boards replaced; metal drip edge at every eave and rake; ice and water shield along the eaves; synthetic underlayment over the whole deck; a starter strip sealing the first course; GAF or TAMKO shingles nailed to the manufacturer's pattern; new pipe boots on every plumbing vent; step and counter flashing where the roof meets the chimney; a ridge vent under the ridge cap; and soffit intake vents, so air comes in at the eaves and leaves at the ridge. Kick-out flashing goes wherever a roof edge runs into a wall. Items marked CODE are required by the Ohio and Kentucky residential codes.</desc>\n`;
s += `  <style>
    .lbl { font: 700 15px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: #1a3057; }
    .sub { font: 400 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: #4a4a4a; }
    .num { font: 800 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: #fff; }
    .code { font: 800 10px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: #fff; letter-spacing: .08em; }
    .ttl { font: 800 21px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: #1a3057; }
    .lead { stroke: #6b7385; stroke-width: 1.2; fill: none; }
    .edge { stroke: rgba(0,0,0,.25); stroke-width: 1; }
    .air { stroke: #2b78c5; stroke-width: 2.4; fill: none; stroke-linecap: round; stroke-dasharray: 7 6; animation: flow 1.6s linear infinite; }
    @keyframes flow { to { stroke-dashoffset: -26; } }
    @media (prefers-reduced-motion: reduce) { .air { animation: none; } }
  </style>\n`;
s += `  <rect width="${W}" height="${H}" fill="#f5f3ef"/>\n`;

// ── Gable end wall (right): rectangle + triangle as one shape, lap siding ──
const gL = add(B, [0, 8]), gR = add(BACK, [0, 8]), peak = add(R2, [0, 16]);
s += `  <polygon points="${pts(add(gL, [0, WALL_H]), gL, peak, gR, add(gR, [0, WALL_H]))}" fill="#ddd4c6" class="edge"/>\n`;
s += `  <clipPath id="gable"><polygon points="${pts(add(gL, [0, WALL_H]), gL, peak, gR, add(gR, [0, WALL_H]))}"/></clipPath>\n`;
s += `  <g clip-path="url(#gable)">\n`;
for (let k = 1; k < 20; k++) s += '  ' + line(add(gL, [0, WALL_H - k * 13]), add(gR, [0, WALL_H - k * 13]), '#cbc1b1', 1);
s += `  </g>\n`;
// gable vent
{ const c = add(peak, [0, 34]); s += `  <polygon points="${pts(add(c, [-14, 8]), add(c, [0, -12]), add(c, [14, 0]), add(c, [0, 20]))}" fill="#8f97a3"/>\n`; }

// ── Front wall ──
const wL = add(A, [10, 8]), wR = add(B, [0, 8]);
s += `  <polygon points="${pts(wL, wR, add(wR, [0, WALL_H]), add(wL, [0, WALL_H]))}" fill="#ebe4d9" class="edge"/>\n`;
for (let y = 13; y < WALL_H; y += 13) s += line(add(wL, [0, y]), add(wR, [0, y]), '#d9d0c2', 1);
s += `  <rect x="${f1(wL[0] + 60)}" y="${f1(wL[1] + 66)}" width="40" height="74" fill="#1a3057" opacity=".88"/>\n`;
for (const dx of [170, 290]) s += `  <rect x="${f1(wL[0] + dx)}" y="${f1(wL[1] + 36)}" width="72" height="48" fill="#a9bccf" stroke="#fff" stroke-width="4"/>\n`;

// fascia + soffit with vent slots under the eave
s += `  <polygon points="${pts(add(A, [-6, 0]), add(B, [4, 0]), add(B, [4, 8]), add(A, [-6, 8]))}" fill="#fbfbfb" class="edge"/>\n`;
for (let u = 0.05; u < 0.97; u += 0.055) { const p = P(u, 0); s += `  <rect x="${f1(p[0])}" y="${f1(p[1] + 10)}" width="11" height="2.6" fill="#5d6673"/>\n`; }

// ── Roof plane, bottom layer first ──
s += `  <polygon points="${quad(0, 1, 0, 1)}" fill="#c8a06a" class="edge"/>\n`;                      // 1 deck
for (let u = 0.6; u < 1; u += 0.1) s += line(P(u, 0), P(u, 1), '#ad8955', 1.2);
s += `  <polygon points="${quad(0.6, 1, 0.955, 0.985)}" fill="#3b2f22"/>\n`;                          // ridge slot
s += `  <polygon points="${quad(0, 0.86, 0, 0.3)}" fill="#2e3440" class="edge"/>\n`;                  // 3 ice & water
s += `  <polygon points="${quad(0, 0.74, 0, 1)}" fill="#a9bccf" class="edge"/>\n`;                    // 4 underlayment
for (let v = 0.25; v < 1; v += 0.25) s += line(P(0, v), P(0.74, v), '#8ea3b9', 1);
s += `  <polygon points="${quad(0, 0.58, 0, 1)}" fill="#4a5059" class="edge"/>\n`;                    // 6 shingles
for (let v = 0.09; v < 0.95; v += 0.075) s += line(P(0, v), P(0.58, v), '#30343b', 1.4);
for (let v = 0.09, k = 0; v < 0.95; v += 0.075, k++) for (let u = (k % 2 ? 0.03 : 0.06); u < 0.58; u += 0.06) s += line(P(u, v), P(u, v - 0.075), '#3a3f47', 1);
s += `  <polygon points="${quad(0, 0.58, 0, 0.045)}" fill="#6b717b"/>\n`;                            // 5 starter strip
// 2 drip edge: eave, left rake, right rake (metal)
s += `  <polygon points="${pts(add(A, [-7, -1]), add(B, [5, -1]), add(B, [5, 4]), add(A, [-7, 4]))}" ${METAL}/>\n`;
s += `  <polygon points="${pts(add(A, [-7, -1]), add(R1, [-7, 0]), add(R1, [-1, 0]), add(A, [-1, -1]))}" ${METAL}/>\n`;
s += `  <polygon points="${pts(add(B, [5, -1]), add(R2, [5, 0]), add(BACK, [5, 0]), add(BACK, [9, 5]), add(R2, [5, 7]), add(B, [9, 5]))}" ${METAL}/>\n`;
// 9 ridge vent + cap
s += `  <polygon points="${pts(add(R1, [-4, -10]), add(R2, [4, -10]), add(R2, [4, 2]), add(R1, [-4, 2]))}" fill="#2f343b" class="edge"/>\n`;
for (let u = 0.02; u < 1; u += 0.04) { const p = P(u, 1); s += `  <rect x="${f1(p[0])}" y="${f1(p[1] - 5)}" width="7" height="3" fill="#59606b"/>\n`; }
// 7 pipe boot
{ const c = P(0.27, 0.5);
  s += `  <ellipse cx="${f1(c[0])}" cy="${f1(c[1] + 3)}" rx="17" ry="6" fill="#b8bec7"/>\n`;
  s += `  <path d="M${f1(c[0] - 9)} ${f1(c[1] + 2)} L${f1(c[0] - 6)} ${f1(c[1] - 12)} L${f1(c[0] + 6)} ${f1(c[1] - 12)} L${f1(c[0] + 9)} ${f1(c[1] + 2)} Z" fill="#bd5728"/>\n`;
  s += `  <rect x="${f1(c[0] - 5)}" y="${f1(c[1] - 30)}" width="10" height="20" fill="#e9e9e9" stroke="#999" stroke-width="1"/>\n`;
  s += `  <ellipse cx="${f1(c[0])}" cy="${f1(c[1] - 30)}" rx="5" ry="2" fill="#777"/>\n`; }
// 8 chimney with step + counter flashing
{ const c0 = P(0.38, 0.55), c1 = P(0.49, 0.55), c2 = P(0.49, 0.8), c3 = P(0.38, 0.8), HC = 80;
  s += `  <polygon points="${pts(add(c0, [-6, 5]), add(c1, [7, 5]), add(c2, [9, 0]), add(c3, [-4, -2]))}" ${METAL}/>\n`;
  s += `  <polygon points="${pts(c0, c1, add(c1, [0, -HC - 30]), add(c0, [0, -HC - 30]))}" fill="#a3462b" class="edge"/>\n`;
  s += `  <polygon points="${pts(c1, c2, add(c2, [0, -HC]), add(c1, [0, -HC - 30]))}" fill="#8a3a23" class="edge"/>\n`;
  s += `  <polygon points="${pts(add(c0, [0, -HC - 30]), add(c1, [0, -HC - 30]), add(c2, [0, -HC]), add(c3, [0, -HC]))}" fill="#6d2e1b" class="edge"/>\n`;
  for (let k = 1; k < 7; k++) s += line(add(c0, [0, -k * 15]), add(c1, [0, -k * 15]), '#7e3520', 1);
  s += `  <polygon points="${pts(add(c0, [0, -16]), add(c1, [0, -16]), add(c1, [0, -10]), add(c0, [0, -10]))}" fill="#9aa2ad"/>\n`;
  s += `  <polygon points="${pts(add(c1, [0, -16]), add(c2, [0, -16]), add(c2, [0, -10]), add(c1, [0, -10]))}" fill="#8a929d"/>\n`; }
// 10 airflow: in at the soffit, out at the ridge
{ const a = P(0.18, 0), b = P(0.22, 1);
  s += `  <path class="air" d="M${f1(a[0])} ${f1(a[1] + 44)} L${f1(a[0])} ${f1(a[1] + 14)} Q ${f1(a[0] + 20)} ${f1(a[1] - 60)} ${f1(b[0] - 10)} ${f1(b[1] - 4)} L ${f1(b[0] - 6)} ${f1(b[1] - 36)}"/>\n`;
  s += `  <path d="M${f1(b[0] - 12)} ${f1(b[1] - 30)} L${f1(b[0] - 6)} ${f1(b[1] - 40)} L${f1(b[0])} ${f1(b[1] - 30)}" fill="none" stroke="#2b78c5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>\n`; }

// ── Callouts: [n, anchor point, side, label y, title, sub, code?] ──
const callouts = [
  [9, P(0.82, 1), 'R', 116, 'Ridge vent + ridge cap', 'Hot attic air out at the peak', true],
  [1, P(0.93, 0.55), 'R', 180, 'Roof deck', 'Rotted boards replaced', false],
  [4, P(0.67, 0.65), 'R', 244, 'Synthetic underlayment', 'Over the whole deck', true],
  [3, P(0.8, 0.15), 'R', 308, 'Ice & water shield', 'Along the eaves', false],
  [2, P(0.97, 0), 'R', 372, 'Drip edge', 'Every eave and rake', true],
  [10, add(P(0.75, 0), [0, 11]), 'R', 436, 'Soffit intake vents', 'Fresh air in at the eaves', true],
  [8, P(0.43, 0.6), 'L', 116, 'Step + counter flashing', 'At chimneys and walls', true],
  [6, P(0.1, 0.75), 'L', 190, 'Shingles', 'GAF or TAMKO, maker’s nail pattern', true],
  [7, P(0.25, 0.48), 'L', 268, 'New pipe boots', 'On every plumbing vent', false],
  [5, P(0.06, 0.02), 'L', 372, 'Starter strip', 'Seals the first course', true],
];
for (const [n, at, side, ly, title, sub, code] of callouts) {
  const cx = side === 'R' ? 950 : 300;
  const tx = side === 'R' ? 972 : 24;
  const ttx = code ? tx + 46 : tx;
  s += `  <path d="M${f1(at[0])} ${f1(at[1])} L${side === 'R' ? cx - 22 : cx + 22} ${ly} L${side === 'R' ? cx - 13 : cx + 13} ${ly}" class="lead"/>\n`;
  s += `  <circle cx="${f1(at[0])}" cy="${f1(at[1])}" r="3" fill="#6b7385"/>\n`;
  s += `  <circle cx="${cx}" cy="${ly}" r="13" fill="#1a3057"/><text x="${cx}" y="${ly + 5}" text-anchor="middle" class="num">${n}</text>\n`;
  if (code) s += `  <rect x="${tx}" y="${ly - 17}" width="38" height="16" rx="3" fill="#bd5728"/><text x="${tx + 19}" y="${ly - 5.5}" text-anchor="middle" class="code">CODE</text>\n`;
  s += `  <text x="${ttx}" y="${ly - 4}" class="lbl">${esc(title)}</text>\n`;
  s += `  <text x="${tx}" y="${ly + 15}" class="sub">${esc(sub)}</text>\n`;
}

// ── Title + footer ──
s += `  <text x="24" y="40" class="ttl">A code-correct NBD roof, cut away</text>\n`;
s += `  <text x="24" y="62" class="sub">Full tear-off first, never a layover. Magnetic nail sweep at the end.</text>\n`;
s += `  <rect x="24" y="532" width="1152" height="66" rx="8" fill="#fff" stroke="#d8d2c7"/>\n`;
s += `  <rect x="40" y="546" width="38" height="16" rx="3" fill="#bd5728"/><text x="59" y="557.5" text-anchor="middle" class="code">CODE</text>\n`;
s += `  <text x="88" y="559" class="sub">Required by the Ohio and Kentucky residential codes. Plenty of roofs get these skipped; every NBD roof gets them.</text>\n`;
s += `  <text x="40" y="584" class="sub">Also code: kick-out flashing wherever a roof edge runs into a wall (not on this roof). Upgrades: LumaNail™ nails, Roofivent ventilation.</text>\n`;
s += `</svg>\n`;
fs.writeFileSync(OUT, s);
console.log('wrote', OUT, s.length);
