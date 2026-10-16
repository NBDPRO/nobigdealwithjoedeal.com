// scripts/illustrations/lib.mjs — the shared drawing kit for NBD's technical
// illustrations (2026-10-16). Every figure is built from these pieces so the
// whole set shares one camera, one palette, one line weight and one callout
// style. Geometry is in INCHES in a world frame:
//   x  along the eave / along the wall (to the viewer's right)
//   y  horizontal depth, away from the viewer (into the house)
//   z  straight up
// One axonometric camera for the whole library: x runs 20° below horizontal,
// y runs 35° above horizontal at 0.72 scale, z is vertical. From that camera
// the TOP (+z), FRONT (-y) and RIGHT (+x) faces of a box are the visible ones,
// so every cutaway steps its layers back toward the left and cuts the section
// on the right-hand face.

export const C = {
  bg: '#ffffff',
  ink: '#12223d',        // navy-dark: outlines, text
  navy: '#1a3057',
  orange: '#bd5728',     // the one accent: callout numbers, the key part
  orangeLight: '#dd875f',
  muted: '#5d6673',
  rule: '#e8e5e0',
  wood: '#dcbc8c', woodDark: '#c9a273', woodGrain: '#b48a57',
  osb: '#d7b585', osbFlake: '#bf9762',
  metal: '#c3cad2', metalDark: '#98a2ad',
  ice: '#343c48', iceGrain: '#4a5363',
  under: '#d9dde3', underLine: '#aeb6c0',
  starter: '#5a616b', sealant: '#1f2329',
  shingle: '#4b535d', shingleDark: '#363c45', shingleShadow: '#262a31', shingleLight: '#5d6670',
  ridge: '#434a54',
  vent: '#2b3037',
  wrap: '#f1f4f7', wrapLine: '#b9c6d3',
  tape: '#c9cfd6',
  siding: '#ece6db', sidingShadow: '#d6cdbf',
  sheath: '#d9bb8b',
  insul: '#f2d27a', insulDark: '#d9b55a',
  drywall: '#efefec',
  brick: '#b5654a',
  air: '#2b78c5', airWarm: '#c8643a',
  water: '#3f8fd0', iceBlue: '#d6ecf8', iceEdge: '#86b6d6', snow: '#ffffff', snowEdge: '#c3d1dd',
  gutter: '#f3f2ee', gutterEdge: '#9aa3ad',
};

// ── camera ──────────────────────────────────────────────────────────────
const D2R = Math.PI / 180;
const AX = [Math.cos(20 * D2R), Math.sin(20 * D2R)];
const AY = [0.72 * Math.cos(35 * D2R), -0.72 * Math.sin(35 * D2R)];
// direction toward the camera (for back-face culling)
export const CAM = (() => {
  const d = [AY[0], -AX[0], AY[0] * AX[1] - AX[0] * AY[1]];
  const n = Math.hypot(...d); return d.map((v) => v / n);
})();

export function camera(scale, ox, oy) {
  return (p) => [ox + (p[0] * AX[0] + p[1] * AY[0]) * scale, oy + (p[0] * AX[1] + p[1] * AY[1] - p[2]) * scale];
}

// ── vectors ─────────────────────────────────────────────────────────────
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const n = Math.hypot(...a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
};

// A frame maps local (a, b, c) to world: origin + a*e1 + b*e2 + c*e3.
export function frame(origin, e1, e2, e3) {
  const f = (a, b, c = 0) => v3.add(origin, v3.add(v3.mul(e1, a), v3.add(v3.mul(e2, b), v3.mul(e3, c))));
  f.e1 = e1; f.e2 = e2; f.e3 = e3; f.origin = origin;
  return f;
}
// A roof plane: a along the eave (x), u up the slope, h normal to the deck.
export function roofPlane(origin, pitch) {
  const t = Math.atan(pitch / 12);
  return Object.assign(frame(origin, [1, 0, 0], [0, Math.cos(t), Math.sin(t)], [0, -Math.sin(t), Math.cos(t)]), { theta: t, pitch });
}

// ── numbers / colour ────────────────────────────────────────────────────
export const r1 = (n) => Math.round(n * 10) / 10;
export const pts = (ps) => ps.map((p) => r1(p[0]) + ',' + r1(p[1])).join(' ');
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgb2hex(r, g, b) { return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
export function mix(a, b, t) { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }
const LIGHT = v3.norm([-0.35, -0.55, 1]);
// Lambert-ish: faces toward the light keep their colour, others darken.
export function shade(hex, n) {
  const k = Math.max(0, v3.dot(v3.norm(n), LIGHT));
  return mix(hex, '#0b1424', 0.36 * (1 - k));
}

// ── SVG builder ─────────────────────────────────────────────────────────
export class Svg {
  constructor({ id, title, desc, w = 1200, h = 900, scale, origin }) {
    this.id = id; this.title = title; this.desc = desc; this.w = w; this.h = h;
    this.P = camera(scale, origin[0], origin[1]);
    this.parts = []; this.defs = []; this.over = [];
    this.uid = 0;
  }
  nid(p) { return `${this.id}-${p}${++this.uid}`; }
  add(s) { this.parts.push(s); return this; }
  top(s) { this.over.push(s); return this; }
  def(s) { this.defs.push(s); return this; }

  // polygon in world coords
  poly(ps3, fill, { stroke = C.ink, sw = 0.8, op, cls, extra = '' } = {}) {
    const a = ps3.map(this.P);
    return `<polygon points="${pts(a)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"` : ''}${op != null ? ` opacity="${op}"` : ''}${cls ? ` class="${cls}"` : ''}${extra}/>`;
  }
  line3(a, b, stroke = C.ink, sw = 0.8, extra = '') {
    const p = this.P(a), q = this.P(b);
    return `<line x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(q[0])}" y2="${r1(q[1])}" stroke="${stroke}" stroke-width="${sw}"${extra}/>`;
  }
  path3(ps3, stroke, sw, extra = '') {
    const a = ps3.map(this.P);
    return `<path d="M${a.map((p) => r1(p[0]) + ' ' + r1(p[1])).join('L')}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
  }

  // A box in a frame: a0..a1 × b0..b1 × c0..c1. Draws only faces that face
  // the camera. `faces` can override a face colour: {top, front, right, ...}.
  box(F, a0, a1, b0, b1, c0, c1, color, { stroke = C.ink, sw = 0.8, faces = {}, flat = false } = {}) {
    const q = (a, b, c) => F(a, b, c);
    const all = [
      ['c1', [q(a0, b0, c1), q(a1, b0, c1), q(a1, b1, c1), q(a0, b1, c1)], F.e3],
      ['c0', [q(a0, b0, c0), q(a0, b1, c0), q(a1, b1, c0), q(a1, b0, c0)], v3.mul(F.e3, -1)],
      ['b0', [q(a0, b0, c0), q(a1, b0, c0), q(a1, b0, c1), q(a0, b0, c1)], v3.mul(F.e2, -1)],
      ['b1', [q(a0, b1, c0), q(a0, b1, c1), q(a1, b1, c1), q(a1, b1, c0)], F.e2],
      ['a1', [q(a1, b0, c0), q(a1, b1, c0), q(a1, b1, c1), q(a1, b0, c1)], F.e1],
      ['a0', [q(a0, b0, c0), q(a0, b0, c1), q(a0, b1, c1), q(a0, b1, c0)], v3.mul(F.e1, -1)],
    ];
    let out = '';
    for (const [k, ps, n] of all) {
      if (v3.dot(n, CAM) <= 1e-6) continue;
      const col = faces[k] || (flat ? color : shade(color, n));
      out += this.poly(ps, col, { stroke, sw });
    }
    return out;
  }

  // ── annotation ──
  // numbered callout: dot on the part, leader, orange disc, label + sub.
  callout(n, target, at, title, sub = '', { side = 'right', key = '' } = {}) {
    const t = Array.isArray(target[0]) ? target : [target];
    const [cx, cy] = at;
    let s = `<g class="co"${key ? ` data-key="${key}"` : ''}>`;
    for (const tp of t) {
      const p = tp.length === 3 ? this.P(tp) : tp;
      s += `<line class="ld" x1="${r1(p[0])}" y1="${r1(p[1])}" x2="${r1(cx)}" y2="${r1(cy)}"/>`;
      s += `<circle class="dt" cx="${r1(p[0])}" cy="${r1(p[1])}" r="3.6"/>`;
    }
    s += `<g class="nb"><circle cx="${r1(cx)}" cy="${r1(cy)}" r="17"/><text x="${r1(cx)}" y="${r1(cy + 6.5)}" text-anchor="middle">${n}</text></g>`;
    const tx = side === 'right' ? cx + 26 : cx - 26, anc = side === 'right' ? 'start' : 'end';
    s += `<text class="lbl" x="${r1(tx)}" y="${r1(cy + (sub ? -2 : 6))}" text-anchor="${anc}">${esc(title)}</text>`;
    if (sub) {
      const lines = Array.isArray(sub) ? sub : [sub];
      lines.forEach((ln, i) => { s += `<text class="sub" x="${r1(tx)}" y="${r1(cy + 17 + i * 18)}" text-anchor="${anc}">${esc(ln)}</text>`; });
    }
    return s + '</g>';
  }
  // dimension along a world segment, offset by a world vector
  dim(a, b, off, label, { ext = true, labelAt = 0.5, dx = 0, dy = 0, anchor = 'middle', cls = 'dim' } = {}) {
    const A = v3.add(a, off), B = v3.add(b, off);
    const pa = this.P(A), pb = this.P(B);
    let s = `<g class="${cls}">`;
    if (ext) { s += this.line3(a, v3.add(A, v3.mul(off, 0.18)), C.orange, 0.9, ' stroke-dasharray="3 3"'); s += this.line3(b, v3.add(B, v3.mul(off, 0.18)), C.orange, 0.9, ' stroke-dasharray="3 3"'); }
    s += `<line x1="${r1(pa[0])}" y1="${r1(pa[1])}" x2="${r1(pb[0])}" y2="${r1(pb[1])}" stroke="${C.orange}" stroke-width="1.6" marker-start="url(#${this.id}-ar)" marker-end="url(#${this.id}-ar)"/>`;
    const m = [pa[0] + (pb[0] - pa[0]) * labelAt + dx, pa[1] + (pb[1] - pa[1]) * labelAt + dy];
    s += `<text class="dl" x="${r1(m[0])}" y="${r1(m[1])}" text-anchor="${anchor}">${esc(label)}</text>`;
    return s + '</g>';
  }
  note(x, y, lines, { anchor = 'start', cls = 'nt' } = {}) {
    return lines.map((ln, i) => `<text class="${cls}" x="${r1(x)}" y="${r1(y + i * 19)}" text-anchor="${anchor}">${esc(ln)}</text>`).join('');
  }

  render({ eyebrow, heading, footnote = '' }) {
    const W = this.w, H = this.h, id = this.id;
    const FONT = `'Montserrat','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
    const css = [
      `.lbl{font:700 17px ${FONT};fill:${C.ink}}`,
      `.sub{font:500 14px ${FONT};fill:${C.muted}}`,
      `.nt{font:500 14px ${FONT};fill:${C.muted}}`,
      `.ntb{font:700 15px ${FONT};fill:${C.ink}}`,
      `.dl{font:800 15px ${FONT};fill:${C.orange};paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round}`,
      `.eb{font:800 13px ${FONT};fill:${C.orange};letter-spacing:.16em}`,
      `.hd{font:800 30px ${FONT};fill:${C.ink}}`,
      `.ft{font:600 13px ${FONT};fill:${C.muted}}`,
      `.bdg{font:700 13px ${FONT};fill:${C.ink}}`,
      `.ld{stroke:${C.ink};stroke-width:1.1;opacity:.75}`,
      `.dt{fill:${C.ink};stroke:#fff;stroke-width:1.6}`,
      `.nb circle{fill:${C.orange};stroke:#fff;stroke-width:2.5}`,
      `.nb text{font:800 18px ${FONT};fill:#fff}`,
      `.tag{font:800 12px ${FONT};fill:#fff;letter-spacing:.08em}`,
      `.lstn{font:800 16px ${FONT}}`,
      // phones: drop the small words, keep big numbers (the page lists them)
      `@media (max-width:640px){.lbl,.sub,.nt,.ntb,.ft,.bdg,.bdgbox,.eb,.hd,.mtxt,.lst,.inset{display:none}.nb{transform-box:fill-box;transform-origin:center;transform:scale(2.1)}.dl{font-size:30px;stroke-width:8px}.dt{r:6px}.ld{stroke-width:2.4}}`,
    ];
    const defs = [
      `<marker id="${id}-ar" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9z" fill="${C.orange}"/></marker>`,
      ...this.defs,
    ];
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="${id}-t ${id}-d">`,
      `<title id="${id}-t">${esc(this.title)}</title>`,
      `<desc id="${id}-d">${esc(this.desc)} Illustration, not a photo of an actual job. Layer thicknesses are exaggerated so each one can be seen.</desc>`,
      `<style>${css.join('')}</style>`,
      `<defs>${defs.join('')}</defs>`,
      `<rect width="${W}" height="${H}" fill="${C.bg}"/>`,
      eyebrow ? `<text class="eb" x="40" y="46">${esc(eyebrow.toUpperCase())}</text>` : '',
      heading ? `<text class="hd" x="40" y="84">${esc(heading)}</text>` : '',
      ...this.parts,
      ...this.over,
      `<g class="bdgbox"><rect x="32" y="${H - 50}" width="332" height="28" rx="14" fill="#fff" stroke="${C.ink}" stroke-width="1.2"/><circle cx="50" cy="${H - 36}" r="5" fill="${C.orange}"/></g>`,
      `<text class="bdg" x="62" y="${H - 31}">Illustration · not a photo of an actual job</text>`,
      footnote ? `<text class="ft" x="${W - 40}" y="${H - 31}" text-anchor="end">${esc(footnote)}</text>` : '',
      `</svg>`,
    ].join('');
  }
}

// ── reusable material helpers ───────────────────────────────────────────
// Laminated architectural shingle courses on a roof plane.
// R = roofPlane; a0..a1 along the eave; first butt at u = uStart;
// exposure ex; height H (13.25 in for GAF HDZ/UHDZ and TAMKO Heritage);
// h = elevation of the course base above the deck. Returns SVG.
export function shingleCourses(svg, R, { a0, a1, uStart, n, ex = 5.625, H = 13.25, h = 0.9, t = 0.32, seed = 7, color = C.shingle, cutRight = null, cutLeft = null, endFace = 'a1' }) {
  let s = '';
  let rnd = seed;
  const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  const right = (i) => (cutRight ? cutRight(i) : a1);
  for (let i = 0; i < n; i++) {
    const ub = uStart + i * ex, ut = ub + H;
    const hb = h + Math.min(i, 1) * t * 0.6; // later courses sit on the one below
    const ar = right(i);
    const al = cutLeft ? cutLeft(i) : a0;
    if (ar <= al + 0.5) continue;
    // body (the part above the next butt is hidden by the next course, but the
    // top of the last course and the cut right end show)
    const F = (a, u, z) => R(a, u, z);
    // cut end (right, or left when the frame's -a face is the visible one)
    const ae = endFace === 'a0' ? al : ar;
    s += svg.poly([F(ae, ub, hb), F(ae, ut, hb), F(ae, ut, hb + t), F(ae, ub, hb + t)], shade(C.shingleDark, endFace === 'a0' ? v3.mul(R.e1, -1) : R.e1), { sw: 0.6 });
    // butt (front) edge
    s += svg.poly([F(al, ub, hb), F(ar, ub, hb), F(ar, ub, hb + t), F(al, ub, hb + t)], C.shingleShadow, { sw: 0.6 });
    // top face
    s += svg.poly([F(al, ub, hb + t), F(ar, ub, hb + t), F(ar, ut, hb + t), F(al, ut, hb + t)], color, { sw: 0.6 });
    // laminated shingle: dark base layer shows in the cut-outs; the upper
    // layer's "dragon teeth" tabs run the full exposure in varied tones
    s += svg.poly([F(al, ub, hb + t), F(ar, ub, hb + t), F(ar, ub + ex, hb + t), F(al, ub + ex, hb + t)], C.shingleShadow, { stroke: null });
    const tones = [C.shingle, C.shingleLight, '#545d68', '#47505a'];
    let a = al - rand() * 12 - ((i * 5.3) % 9);
    while (a < ar) {
      const w = 5 + rand() * 7, gap = 1.1 + rand() * 1.9;
      const L = Math.max(a, al), Rr = Math.min(a + w, ar);
      if (Rr - L > 0.3) {
        const tone = tones[Math.floor(rand() * tones.length)];
        const cut = ub + ex * (0.18 + rand() * 0.22);   // the notch line of the tab
        s += svg.poly([F(L, ub, hb + t), F(Rr, ub, hb + t), F(Rr, ub + ex, hb + t), F(L, ub + ex, hb + t)], tone, { stroke: null });
        s += svg.poly([F(L, cut, hb + t), F(Rr, cut, hb + t), F(Rr, cut + 0.45, hb + t), F(L, cut + 0.45, hb + t)], C.shingleShadow, { stroke: null, op: 0.35 });
      }
      a += w + gap;
    }
    // granule glint line just above the butt
    s += svg.line3(F(al, ub + 0.35, hb + t), F(ar, ub + 0.35, hb + t), '#6c7580', 0.6);
  }
  return s;
}

// OSB-ish flakes on a face (deterministic)
export function flakes(svg, F, a0, a1, b0, b1, c, n, color = C.osbFlake, seed = 3) {
  let s = '', r = seed;
  const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  for (let i = 0; i < n; i++) {
    const a = a0 + rand() * (a1 - a0), b = b0 + rand() * (b1 - b0), L = 1 + rand() * 2.5, ang = rand() * Math.PI;
    const p = F(a, b, c), q = F(a + Math.cos(ang) * L, b + Math.sin(ang) * L * 0.6, c);
    if (a + Math.cos(ang) * L > a1 || a + Math.cos(ang) * L < a0 || b + Math.sin(ang) * L * 0.6 > b1 || b + Math.sin(ang) * L * 0.6 < b0) continue;
    s += svg.line3(p, q, color, 1.1, ' stroke-linecap="round" opacity=".8"');
  }
  return s;
}

// section hatch pattern (screen space, 45°) for cut wood/metal faces
export function hatchDef(svg, name, color, bg, gap = 6) {
  svg.def(`<pattern id="${svg.id}-${name}" patternUnits="userSpaceOnUse" width="${gap}" height="${gap}" patternTransform="rotate(45)"><rect width="${gap}" height="${gap}" fill="${bg}"/><line x1="0" y1="0" x2="0" y2="${gap}" stroke="${color}" stroke-width="1"/></pattern>`);
  return `url(#${svg.id}-${name})`;
}

// Extrude a closed (y, z) profile along x from x0 to x1 (counter-clockwise
// with y to the right, z up). Draws the camera-facing side faces and the
// right-hand end cap (the section cut), optionally with a hatch fill.
export function extrudeX(svg, prof, x0, x1, color, { cap, sw = 0.8, stroke = C.ink, capStroke } = {}) {
  let s = '';
  const n = prof.length;
  for (let i = 0; i < n; i++) {
    const p = prof[i], q = prof[(i + 1) % n];
    const nrm = [0, q[1] - p[1], -(q[0] - p[0])];
    if (v3.dot(nrm, CAM) <= 1e-6) continue;
    s += svg.poly([[x0, p[0], p[1]], [x1, p[0], p[1]], [x1, q[0], q[1]], [x0, q[0], q[1]]], shade(color, nrm), { stroke, sw });
  }
  s += svg.poly(prof.map(([y, z]) => [x1, y, z]), cap || shade(color, [1, 0, 0]), { stroke: capStroke || stroke, sw });
  return s;
}
// Extrude a closed (x, z) profile along y from y0 (front) to y1 (back);
// draws side faces and the FRONT cap at y0.
export function extrudeY(svg, prof, y0, y1, color, { cap, sw = 0.8, stroke = C.ink } = {}) {
  let s = '';
  const n = prof.length;
  for (let i = 0; i < n; i++) {
    const p = prof[i], q = prof[(i + 1) % n];
    const nrm = [-(q[1] - p[1]), 0, q[0] - p[0]];
    if (v3.dot(nrm, CAM) <= 1e-6) continue;
    s += svg.poly([[p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]]], shade(color, nrm), { stroke, sw });
  }
  s += svg.poly(prof.map(([x, z]) => [x, y0, z]), cap || shade(color, [0, -1, 0]), { stroke, sw });
  return s;
}
// Sheet metal as a bent ribbon: an open (y, z) polyline extruded along x.
export function ribbonX(svg, line, x0, x1, color, { sw = 0.7, edge = 1.6 } = {}) {
  let s = '';
  for (let i = 0; i < line.length - 1; i++) {
    const p = line[i], q = line[i + 1];
    let nrm = [0, q[1] - p[1], -(q[0] - p[0])];
    if (v3.dot(nrm, CAM) < 0) nrm = v3.mul(nrm, -1);
    s += svg.poly([[x0, p[0], p[1]], [x1, p[0], p[1]], [x1, q[0], q[1]], [x0, q[0], q[1]]], shade(color, nrm), { sw });
  }
  s += svg.path3(line.map(([y, z]) => [x1, y, z]), C.ink, edge);
  return s;
}
// Point on a roof plane's surface at elevation h (for callout targets).
export const on = (R, a, u, h = 0) => R(a, u, h);

// Sheet metal in any frame: an open (a, c) polyline extruded along b.
export function ribbonF(svg, F, line, b0, b1, color, { sw = 0.7, edge = 1.6, endAt = 'b0' } = {}) {
  let s = '';
  const faces = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [pa, pc] = line[i], [qa, qc] = line[i + 1];
    const quad = [F(pa, b0, pc), F(qa, b0, qc), F(qa, b1, qc), F(pa, b1, pc)];
    let n = v3.cross(v3.sub(quad[1], quad[0]), v3.sub(quad[3], quad[0]));
    if (v3.dot(n, CAM) < 0) n = v3.mul(n, -1);
    faces.push([quad, n]);
  }
  for (const [q, n] of faces) s += svg.poly(q, shade(color, n), { sw });
  const b = endAt === 'b0' ? b0 : b1;
  s += svg.path3(line.map(([a, c]) => F(a, b, c)), C.ink, edge);
  return s;
}
