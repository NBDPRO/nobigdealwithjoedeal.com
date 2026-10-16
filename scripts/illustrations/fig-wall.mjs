// #9 — siding wall, layer by layer (fiber cement lap siding).
import { Svg, C, extrudeX, frame, r1 } from './lib.mjs';

const I = frame([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);

export function sidingWall() {
  const svg = new Svg({
    id: 'wall', scale: 9.0, origin: [300, 590],
    title: 'A siding wall, layer by layer',
    desc: 'A cutaway of an exterior wall. Wood studs carry plywood or OSB sheathing. A water-resistive barrier (housewrap) covers the sheathing, each upper sheet lapped over the one below so water runs out, with flashing tape sealing seams and anything that comes through the wall. A starter strip sets the angle of the first board. Fiber cement lap siding goes on with at least 1 and 1/4 inches of overlap, blind-nailed near the top of each board into the studs so the next board hides the nails, and a strip of joint flashing sits behind each butt joint.',
  });
  const X = 60, Z = 50;
  // foundation + sill
  svg.add(svg.box(I, 0, X, -0.5, 7, -5, 0, '#d4d1cb', {}));
  // framing: bottom/top plates + studs 16 in o.c. (2x4)
  svg.add(svg.box(I, 0, X, 0, 3.5, 0, 1.5, C.wood, {}));
  for (const x of [8, 24, 40, 56]) svg.add(svg.box(I, x - 0.75, x + 0.75, 0, 3.5, 1.5, Z, C.wood, {}));
  // sheathing (cut back at x = 52 to show the framing)
  svg.add(svg.box(I, 0, 52, -0.5, 0, 0, Z, C.sheath, {}));
  // housewrap, two courses lapped shingle-style
  const wy0 = -0.62, wy1 = -0.5;
  svg.add(svg.box(I, 0, 45, wy0, wy1, 0, 28, C.wrap, { faces: { b0: '#eef2f6' } }));
  svg.add(svg.box(I, 0, 45, wy0 - 0.06, wy1 - 0.06, 24, Z, C.wrap, { faces: { b0: '#f3f6f9' } }));
  svg.add(svg.line3([0.3, wy0 - 0.07, 24], [44.7, wy0 - 0.07, 24], C.wrapLine, 1.6));
  for (const z of [10, 18, 34, 42]) svg.add(svg.line3([0.6, wy0 - 0.08, z], [44.4, wy0 - 0.08, z], C.wrapLine, 0.9, ' stroke-dasharray="2 6"'));
  // a pipe through the wall, sealed with flashing tape (shingle-lapped pieces)
  const px = 40, pz = 36;
  svg.add(svg.poly([[px - 4, wy0 - 0.1, pz - 4], [px + 4, wy0 - 0.1, pz - 4], [px + 4, wy0 - 0.1, pz + 4], [px - 4, wy0 - 0.1, pz + 4]], C.tape, { sw: 0.9 }));
  { const c = svg.P([px, wy0 - 0.2, pz]); svg.add(`<ellipse cx="${r1(c[0])}" cy="${r1(c[1])}" rx="13" ry="12" fill="#e9e7e2" stroke="${C.ink}" stroke-width="1"/><ellipse cx="${r1(c[0] - 3)}" cy="${r1(c[1] + 2)}" rx="7" ry="6.5" fill="#bfc4ca"/>`); }
  // starter strip (1 1/4 in) at the bottom
  svg.add(svg.box(I, 0, 36, wy0 - 0.45, wy0 - 0.02, 0.2, 1.45, '#e9e2d5', {}));
  // lap siding: 8 1/4 in boards, 7 in exposure (1 1/4 in overlap)
  const W8 = 8.25, EXP = 7, t = 0.45;
  const plank = (zb, x0, x1, col = '#fbf8f2') => {
    const back = wy0 - 0.04, kick = 0.85;          // the board below kicks the butt out
    const prof = [[back - kick, zb], [back - kick - t, zb], [back - t, zb + W8], [back, zb + W8]];
    return extrudeX(svg, prof, x0, x1, col, {});
  };
  let zb = 0.2;
  const tops = [];
  for (let i = 0; i < 6; i++) {
    const x1 = 34 - (i === 5 ? 6 : 0);
    if (i === 3) {                                    // a butt joint with joint flashing behind it
      svg.add(svg.box(I, 25, 31, wy0 - 0.12, wy0 - 0.05, zb + 0.6, zb + W8 - 0.6, C.metal, {}));
      svg.add(plank(zb, 0, 28));
    } else svg.add(plank(zb, 0, x1));
    tops.push(zb + W8);
    zb += EXP;
  }
  // blind nails along the top of the last board, at the studs
  for (const x of [8, 24]) { const p = svg.P([x, wy0 - 0.3, tops[5] - 0.9]); svg.add(`<circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="4" fill="#8a929c" stroke="${C.ink}" stroke-width="1"/>`); }
  // overlap dimension on the board ends
  svg.top(svg.dim([28, wy0 - 1.2, tops[4] - 1.25], [28, wy0 - 1.2, tops[4]], [6.5, 0, 0], '1¼ in min.', { dx: 50, dy: 4 }));

  svg.top(svg.callout(1, [56.6, 1.5, 30], [980, 210], 'Studs', ['16 in apart here; siding', 'nails go into them']));
  svg.top(svg.callout(2, [50, -0.5, 36], [980, 320], 'Sheathing', ['Plywood or OSB']));
  svg.top(svg.callout(3, [44, wy0 - 0.06, 30], [980, 430], 'Housewrap (WRB)', ['Upper sheet laps over', 'the lower, shingle-style']));
  svg.top(svg.callout(4, [px + 3, wy0 - 0.1, pz - 3], [980, 120], 'Flashing tape', ['Seals seams and anything', 'through the wall']));
  svg.top(svg.callout(5, [35, wy0 - 0.45, 0.8], [980, 760], 'Starter strip', ['1¼ in: sets the angle', 'of the first board']));
  svg.top(svg.callout(6, [14, wy0 - 1.1, 12], [250, 640], 'Fiber cement lap siding', ['At least 1¼ in overlap'], { side: 'left' }));
  svg.top(svg.callout(7, [8, wy0 - 0.3, tops[5] - 0.9], [250, 220], 'Blind nails', ['Near the top, into studs;', 'the next board hides them'], { side: 'left' }));
  svg.top(svg.callout(8, [30, wy0 - 0.12, 26], [980, 620], 'Joint flashing', ['Behind every butt joint']));
  return svg.render({
    eyebrow: 'How it’s built · Siding', heading: 'What’s behind the siding matters most.',
    footnote: 'Per James Hardie HardiePlank HZ5 instructions (HS11117) · OH & KY R703.2, R703.4',
  });
}
