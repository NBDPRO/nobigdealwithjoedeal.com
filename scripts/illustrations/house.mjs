// A simple gable house, cut through on the right (x = X1) so its section
// shows. Inches. Used by the ventilation, ice-dam and inspection figures.
import { C, shade } from './lib.mjs';

export const H = {
  W: 288, WALL: 96, OH: 18, PITCH: 6, X1: 228, RAFT: 7.25,
};
H.RISE = (H.W / 2) * (H.PITCH / 12);
H.T = Math.atan(H.PITCH / 12);
// underside of the deck (top of rafters) along the section, y in -OH..W+OH
H.deck = (y) => H.WALL + H.RAFT + (y <= H.W / 2 ? y : H.W - y) * (H.PITCH / 12);

export function houseShell(svg, { D = 240, windows = true, siding = true, roofLines = true, roofColor = C.shingle } = {}) {
  // ridge runs along y (away from the viewer); the FRONT face (y = 0) is the cut
  const { W, WALL, OH } = H, d = H.deck, top = (x) => d(x) + 2.6;
  let s = '';
  // right side wall (x = W face)
  s += svg.poly([[W, 0, 0], [W, D, 0], [W, D, WALL], [W, 0, WALL]], C.siding, {});
  if (siding) for (let z = 7; z < WALL; z += 7) s += svg.line3([W, 0, z], [W, D, z], C.sidingShadow, 1);
  if (windows) for (const [a, b] of [[40, 76], [150, 186]]) {
    s += svg.poly([[W, a, 36], [W, b, 36], [W, b, 78], [W, a, 78]], '#ffffff', { sw: 1.4 });
    s += svg.poly([[W, a + 3, 39], [W, b - 3, 39], [W, b - 3, 75], [W, a + 3, 75]], '#a9bccf', { sw: 0.8 });
    s += svg.line3([W, (a + b) / 2, 39], [W, (a + b) / 2, 75], '#fff', 2);
  }
  // right fascia (x = W + OH face)
  s += svg.poly([[W + OH, 0, d(W + OH) - 6], [W + OH, D, d(W + OH) - 6], [W + OH, D, top(W + OH)], [W + OH, 0, top(W + OH)]], '#f4f1ea', {});
  // both roof slopes
  for (const [x0, x1] of [[-OH, W / 2], [W / 2, W + OH]]) {
    const n = x0 < 0 ? [-0.45, 0, 0.9] : [0.45, 0, 0.9];
    s += svg.poly([[x0, 0, top(x0)], [x1, 0, top(x1)], [x1, D, top(x1)], [x0, D, top(x0)]], shade(roofColor, n), {});
    if (roofLines) {
      const step = 5.625 * Math.cos(H.T);
      for (let k = step; k < W / 2 + OH - 2; k += step) {
        const x = x0 < 0 ? -OH + k : W + OH - k;
        s += svg.line3([x, 0, top(x)], [x, D, top(x)], C.shingleShadow, 0.8);
      }
    }
  }
  s += svg.poly([[W / 2 - 5, 0, top(W / 2 - 5) + 1.4], [W / 2 + 5, 0, top(W / 2 + 5) + 1.4], [W / 2 + 5, D, top(W / 2 + 5) + 1.4], [W / 2 - 5, D, top(W / 2 - 5) + 1.4]], C.ridge, {});
  return s;
}

// The section face at x = X1: outline + interior pieces. `opts.inside`
// draws extra content in section coordinates.
export function houseSection(svg, { insulation = true, baffles = true, ridgeVent = true, soffitVent = true, warm = false } = {}) {
  const { W, WALL, OH } = H, d = H.deck;
  const S = (x, z) => [x, 0, z];
  let s = '';
  // attic air space (light) and rooms below
  const attic = [S(0, WALL), S(W, WALL), S(W + OH, d(W + OH)), S(W / 2, d(W / 2)), S(-OH, d(-OH))];
  s += svg.poly([S(0, 0), S(W, 0), S(W, WALL), S(0, WALL)], warm ? '#fbe9df' : '#f6f4ef', {});
  s += svg.poly(attic, warm ? '#f7ede6' : '#eef3f7', { sw: 1 });
  // walls (cut)
  for (const y of [0, W - 5.5]) s += svg.poly([S(y, 0), S(y + 5.5, 0), S(y + 5.5, WALL), S(y, WALL)], C.woodDark, { sw: 1 });
  // ceiling / attic floor
  s += svg.poly([S(0, WALL - 1), S(W, WALL - 1), S(W, WALL + 1.5), S(0, WALL + 1.5)], C.drywall, { sw: 0.8 });
  // soffits (boxed) with vents
  for (const [a, b] of [[-OH, 0], [W, W + OH]]) {
    const zs = d(-OH) - 6;
    s += svg.poly([S(a, zs), S(b, zs), S(b, zs + 1.2), S(a, zs + 1.2)], '#f4f1ea', { sw: 0.9 });
    if (soffitVent) for (let y = a + 3; y < b - 2; y += 3) s += svg.line3(S(y, zs - 0.2), S(y + 1.4, zs - 0.2), C.ink, 1.6);
  }
  // insulation on the attic floor (thinner toward the eaves)
  if (insulation) {
    const ins = [];
    for (let y = 5.5; y <= W - 5.5; y += 6) {
      const roomUnderDeck = d(y) - WALL - 2.5 - (baffles ? 2 : 0);
      ins.push([y, WALL + 1.5 + Math.max(2, Math.min(14, roomUnderDeck))]);
    }
    s += svg.poly([S(5.5, WALL + 1.5), ...ins.map(([y, z]) => S(y, z)), S(W - 5.5, WALL + 1.5)], C.insul, { stroke: C.insulDark, sw: 1 });
  }
  // rafters/deck/shingles along both slopes (section)
  const slope = (y0, y1) => {
    const p = []; for (let i = 0; i <= 12; i++) p.push(y0 + (y1 - y0) * (i / 12)); return p;
  };
  for (const [a, b] of [[-OH, W / 2 - (ridgeVent ? 1.5 : 0)], [W / 2 + (ridgeVent ? 1.5 : 0), W + OH]]) {
    const ys = slope(a, b);
    s += svg.poly([...ys.map((y) => S(y, d(y) - H.RAFT)), ...ys.slice().reverse().map((y) => S(y, d(y)))], C.wood, { sw: 0.8 });
    s += svg.poly([...ys.map((y) => S(y, d(y))), ...ys.slice().reverse().map((y) => S(y, d(y) + 1.2))], C.osb, { sw: 0.8 });
    s += svg.poly([...ys.map((y) => S(y, d(y) + 1.2)), ...ys.slice().reverse().map((y) => S(y, d(y) + 2.6))], C.shingle, { sw: 0.8 });
  }
  // baffles: keep an air channel from the soffit up past the insulation
  if (baffles) for (const [a, b] of [[-2, 46], [W + 2, W - 46]]) {
    s += svg.path3([S(a, d(a) - H.RAFT - 0.2), S(a + (b - a) * 0.05, d(a) - H.RAFT - 2), S(b, d(b) - H.RAFT - 2)], '#5d8fb9', 2.2);
  }
  // ridge vent
  if (ridgeVent) {
    const yz = d(W / 2);
    s += svg.poly([S(W / 2 - 9, d(W / 2 - 9) + 2.8), S(W / 2, yz + 6.2), S(W / 2 + 9, d(W / 2 + 9) + 2.8), S(W / 2 + 9, d(W / 2 + 9) + 4.2), S(W / 2, yz + 7.8), S(W / 2 - 9, d(W / 2 - 9) + 4.2)], C.ridge, { sw: 0.9 });
  }
  return s;
}
