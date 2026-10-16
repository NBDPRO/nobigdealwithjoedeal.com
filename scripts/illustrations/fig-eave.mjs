// Eave edge detail (#2) and starter-strip overhang (#15).
import { Svg, C, roofPlane, extrudeX, ribbonX, shingleCourses, flakes, hatchDef, shade, v3 } from './lib.mjs';

const PITCH = 6;
const T = Math.atan(PITCH / 12), TAN = Math.tan(T), COS = Math.cos(T), SIN = Math.sin(T);
const DECK = 0.6;                         // drawn thickness (real: 7/16–5/8 in)
const FASCIA_Y = -0.75;                   // fascia face; deck runs flush to it
const WALL_Y = 9;                         // outside face of the wall sheathing

// The common eave block used by both figures.
export function eaveBlock(svg, { X1 = 40, steps, ulen = 48, showWall = true, ice = true }) {
  const R = roofPlane([0, FASCIA_Y, FASCIA_Y * TAN], PITCH);  // origin: deck bottom at the eave edge
  const woodCut = hatchDef(svg, 'wood', C.woodDark, C.wood, 6);
  const wallCut = hatchDef(svg, 'wall', '#b9b2a6', '#e4ded3', 6);
  let s = '';
  // wall below the overhang (sheathing + lap siding), cut at X1
  if (showWall) {
    const zTop = WALL_Y * TAN - 6.15 - 0.2;
    s += extrudeX(svg, [[WALL_Y - 0.6, -14], [WALL_Y + 6, -14], [WALL_Y + 6, zTop], [WALL_Y - 0.6, zTop]], 0, X1, C.siding, { cap: wallCut });
    for (let z = -13.4; z < zTop - 0.5; z += 3.2) s += svg.line3([0, WALL_Y - 0.6, z], [X1, WALL_Y - 0.6, z], C.sidingShadow, 1.4);
  }
  // soffit (level) from fascia back to the wall
  const zs = -6.6;
  s += extrudeX(svg, [[0, zs - 0.5], [WALL_Y - 0.6, zs - 0.5], [WALL_Y - 0.6, zs], [0, zs]], 0, X1, '#e9e6df', {});
  // the rafter at the cut: plumb tail, 2x6 (5.5 in deep, square to the slope)
  const dz = 5.5 / COS;
  const raf = [[0, -dz], [ulen * COS, ulen * COS * TAN - dz], [ulen * COS, ulen * COS * TAN], [0, 0]];
  s += extrudeX(svg, raf, X1 - 1.5, X1, C.wood, { cap: woodCut });
  // fascia board (1x6 face), cut at X1
  s += extrudeX(svg, [[FASCIA_Y, -6.9], [0, -6.9], [0, -0.1], [FASCIA_Y, -0.1]], 0, X1, '#f4f1ea', { cap: woodCut });
  // roof deck
  s += svg.box(R, 0, X1, 0, ulen, 0, DECK, C.osb, { faces: { a1: woodCut } });
  s += flakes(svg, R, 0.5, X1 - 0.5, 0.5, ulen - 0.5, DECK, 260);
  return { R, s };
}

// #2 — the eave: drip edge first, ice barrier over it, underlayment over that.
export function eaveDetail() {
  const svg = new Svg({
    id: 'eave', scale: 9.9, origin: [290, 520],
    title: 'Roof eave edge, layer by layer',
    desc: 'A cutaway of a roof eave. Metal drip edge is nailed to the roof deck first and turns down over the fascia. Ice and water shield goes on next and laps over the drip edge, running from the eave to at least 24 inches inside the exterior wall line, measured along the slope. Synthetic underlayment laps over the top of the ice and water shield. The starter strip and the first course of shingles hang a little past the drip edge so water drips clear.',
  });
  const X1 = 46, ULEN = 48;
  const { R, s: base } = eaveBlock(svg, { X1, ulen: ULEN });
  svg.add(base);
  const h0 = DECK;
  // 2. drip edge: flange 2.5 in up the deck, down over the fascia, kicked out
  const fy = FASCIA_Y, ztop = R(0, 0, h0)[2];
  const flangeEnd = R(0, 2.5, h0);
  const drip = [[flangeEnd[1], flangeEnd[2] + 0.08], [fy - 0.08, ztop + 0.08], [fy - 0.25, ztop - 1.9], [fy - 0.9, ztop - 2.35]];
  svg.add(ribbonX(svg, drip, 0, X1 - 2, C.metal));
  // 3. ice & water shield over the drip edge flange, eave edge to u = 36
  const IW = 36;
  const hi0 = h0 + 0.1, hi1 = hi0 + 0.2;
  svg.add(svg.box(R, 0, X1 - 6, 0, IW, hi0, hi1, C.ice, {}));
  for (let u = 3; u < IW; u += 3.3) svg.add(svg.line3(R(0.4, u, hi1), R(X1 - 6.4, u, hi1), C.iceGrain, 0.8, ' opacity=".7"'));
  // 4. synthetic underlayment, lapped over the top of the ice barrier
  const hu0 = hi1, hu1 = hu0 + 0.12;
  svg.add(svg.box(R, 0, X1 - 12, 30, ULEN, hu0 + 0.01, hu1 + 0.01, C.under, {}));
  for (const u of [33, 40, 47]) svg.add(svg.line3(R(0.3, u, hu1 + 0.01), R(X1 - 12.3, u, hu1 + 0.01), C.underLine, 1.1, ' stroke-dasharray="6 4"'));
  // 5. starter strip: 1/4–3/4 in past the edge; factory sealant near the eave
  const hs0 = hi1, hs1 = hs0 + 0.28;
  svg.add(svg.box(R, 0, X1 - 16, -0.5, 7, hs0, hs1, C.starter, {}));
  svg.add(svg.line3(R(0.3, 1.2, hs1), R(X1 - 16.3, 1.2, hs1), C.sealant, 2.4, ' stroke-dasharray="5 3"'));
  // 6. shingles
  svg.add(shingleCourses(svg, R, { a0: 0, a1: X1 - 25, uStart: -0.5, n: 7, h: hs1, cutRight: (i) => X1 - 25 - i * 0.9 }));

  // exterior wall line projected up to the deck, and the 24 in dimension
  const uWall = (WALL_Y - FASCIA_Y) / COS;
  const pW = R(X1, uWall, DECK);
  svg.add(svg.line3([X1, WALL_Y, -14], pW, C.orange, 1.4, ' stroke-dasharray="7 5"'));
  svg.add(svg.dim(R(X1, uWall, DECK), R(X1, uWall + 24, DECK), [0, 0, 7.5], '24 in min.', { dy: -8, labelAt: 0.5 }));
  svg.add(svg.line3(R(X1 - 6, IW, hi1), R(X1, IW, DECK), C.orange, 1, ' stroke-dasharray="3 3"'));

  // callouts
  const L = 40, Rx = 960;
  svg.top(svg.callout(1, R(34, 44, DECK), [Rx, 150], 'Roof deck', ['Solid plywood or OSB,', 'rotted boards replaced']));
  svg.top(svg.callout(2, [X1 - 3, drip[2][0], drip[2][1]], [Rx, 640], 'Drip edge goes on FIRST', ['Nailed to the deck at the eave,', 'turned down over the fascia']));
  svg.top(svg.callout(3, R(X1 - 8, 14, hi1), [Rx, 470], 'Ice & water shield', ['Laps OVER the eave drip edge,', 'runs 24 in+ past the wall line']));
  svg.top(svg.callout(4, R(X1 - 15, 41, hu1), [Rx, 300], 'Synthetic underlayment', ['Laps over the ice barrier,', 'shingle-style, so water runs out']));
  svg.top(svg.callout(5, R(X1 - 19, 3.5, hs1), [250, 690], 'Starter strip', ['Sealant row at the eave;', '¼–¾ in past the edge'], { side: 'left' }));
  svg.top(svg.callout(6, R(8, 22, 1.6), [250, 230], 'Shingles', ['First course flush', 'over the starter'], { side: 'left' }));
  svg.top(svg.callout(7, [X1, WALL_Y, -10], [Rx, 760], 'Exterior wall line', ['Projected up to the deck:', 'the 24 in starts here']));
  void L; void v3; void shade;
  return svg.render({
    eyebrow: 'How it’s built · The eave', heading: 'Drip edge first. Ice barrier over it.',
    footnote: 'Per GAF Timberline HDZ/UHDZ instructions · OH & KY residential code R905.1.2',
  });
}
