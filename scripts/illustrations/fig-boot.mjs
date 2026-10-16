// #14 — pipe boot (plumbing vent) flashing, lapped shingle-fashion.
import { Svg, C, roofPlane, shingleCourses, flakes, shade, v3, r1 } from './lib.mjs';

const PITCH = 6, EX = 5.625;

// vertical cylinder from a base ring (following the roof plane) to a top z
function cylinder(svg, R, a, u, h, rad, zTop, color, n = 28) {
  const base = [], top = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2, c = R(a, u, h);
    const p = [c[0] + Math.cos(t) * rad, c[1] + Math.sin(t) * rad];
    const zb = R(0, 0, 0)[2] + (p[1] - R(0, 0, 0)[1]) * Math.tan(R.theta) + h;
    base.push([p[0], p[1], zb]); top.push([p[0], p[1], zTop]);
  }
  let s = '';
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, t = ((i + 0.5) / n) * Math.PI * 2, nrm = [Math.cos(t), Math.sin(t), 0];
    if (v3.dot(nrm, [0.47, -0.75, 0.47]) <= 0) continue;
    const col = shade(color, nrm);
    s += svg.poly([base[i], base[j], top[j], top[i]], col, { stroke: col, sw: 0.8 });
  }
  s += svg.poly(top, shade(color, [0, 0, 1]), { sw: 0.9 });
  // silhouette lines
  const pts2 = base.concat(top).map(svg.P);
  let L = 0, Rr = 0;
  pts2.forEach((p, i) => { if (p[0] < pts2[L][0]) L = i; if (p[0] > pts2[Rr][0]) Rr = i; });
  void L; void Rr;
  return s;
}

export function pipeBoot() {
  const svg = new Svg({
    id: 'boot', scale: 10.2, origin: [300, 590],
    title: 'Pipe boot flashing around a plumbing vent',
    desc: 'A plumbing vent pipe coming through the roof, with some shingles cut away. The pipe boot is a flat metal or plastic flange with a rubber collar that hugs the pipe. The bottom edge of the flange sits on top of the shingles below it, so water runs off onto them. The top and sides of the flange slide under the shingles above, and its nails are up where those shingles cover them. Every lap points downhill, the same way the shingles do.',
  });
  const R = roofPlane([0, 0, 0], PITCH);
  const X1 = 50, UL = 44, D = 0.6;
  svg.add(svg.box(R, 0, X1, 0, UL, 0, D, C.osb, {}));
  svg.add(flakes(svg, R, 1, X1 - 1, 1, UL - 1, D, 140));
  const hu = D + 0.12;
  svg.add(svg.box(R, 0, X1 - 3, 0, UL, D, hu, C.under, {}));
  const pa = 25, pu = 21;                         // pipe centre
  const ub = (i) => -0.5 + i * EX;
  // courses below the flange
  const nBelow = 3;
  svg.add(shingleCourses(svg, R, { a0: 0, a1: X1 - 6, uStart: ub(0), n: nBelow, h: hu, seed: 51 }));
  // flange: 12 x 14 in; bottom edge sits ON the exposed part of course 2
  const hf = hu + 0.62, f0 = ub(nBelow - 1) + 2.2, f1 = f0 + 14, fa0 = pa - 6, fa1 = pa + 6;
  svg.add(svg.box(R, fa0, fa1, f0, f1, hf - 0.12, hf, '#b9c0c8', {}));
  // nails in the top corners (covered later)
  for (const a of [fa0 + 1.2, fa1 - 1.2]) { const p = svg.P(R(a, f1 - 1.4, hf)); svg.add(`<circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="3.6" fill="#7d8792" stroke="${C.ink}" stroke-width="1"/>`); }
  // courses above: the one that covers the flange's top + sides, cut away on the left to show it
  for (let i = nBelow; i < nBelow + 4; i++) {
    svg.add(shingleCourses(svg, R, { a0: pa, a1: X1 - 6, uStart: ub(i), n: 1, h: hu + 0.32, seed: 60 + i }));
  }
  // left part of the course right above the flange bottom: covers the flange sides
  // rubber collar + pipe
  const zc = R(pa, pu, hf)[2];
  svg.add(cylinder(svg, R, pa, pu, hf, 3.6, zc + 3.4, '#3b4048'));
  svg.add(cylinder(svg, R, pa, pu, hf, 1.9, zc + 12, '#e9e7e2'));
  // water arrows over the flange bottom onto the shingles below
  svg.add(svg.path3([R(pa - 3, f0 + 8, hf + 0.3), R(pa - 3.2, f0 + 1.5, hf + 0.3), R(pa - 3.4, f0 - 2.5, hu + 0.9)], C.water, 2.6, ' stroke-dasharray="1 6"'));
  svg.add(svg.path3([R(pa + 3, f0 + 8, hf + 0.3), R(pa + 3.2, f0 + 1.5, hf + 0.3), R(pa + 3.4, f0 - 2.5, hu + 0.9)], C.water, 2.6, ' stroke-dasharray="1 6"'));

  svg.top(svg.callout(1, R(pa - 4, f0 + 0.8, hf), [250, 700], 'Bottom edge ON TOP', ['of the shingles below, so', 'water runs off onto them'], { side: 'left' }));
  svg.top(svg.callout(2, R(fa0 + 1.2, f1 - 1.4, hf), [250, 300], 'Top & sides UNDER', ['the shingles above; nails', 'up where they’re covered'], { side: 'left' }));
  svg.top(svg.callout(3, [R(pa, pu, 0)[0] + 2.6, R(pa, pu, 0)[1] - 2, zc + 2], [960, 330], 'Rubber collar', ['Hugs the pipe; replaced', 'when it cracks']));
  svg.top(svg.callout(4, [R(pa, pu, 0)[0] + 1.4, R(pa, pu, 0)[1] - 1.2, zc + 9], [960, 190], 'Plumbing vent pipe'));
  svg.top(svg.callout(5, R(40, 30, hu + 0.7), [960, 520], 'Shingles fit around it', ['cut neatly to the collar']));
  return svg.render({
    eyebrow: 'How it’s built · Pipe boots', heading: 'Every lap points downhill.',
    footnote: 'Generic detail · OH & KY R905.2.8.4: follow the shingle maker’s instructions',
  });
}
