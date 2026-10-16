// #4 — step flashing and kick-out flashing where a roof meets a sidewall.
// The sidewall is the plane x = 0 (facing the camera's right side); the roof
// runs from it to the right and rises away from the viewer.
import { Svg, C, roofPlane, extrudeX, shingleCourses, flakes, shade } from './lib.mjs';

const PITCH = 6;
const T = Math.atan(PITCH / 12), TAN = Math.tan(T), COS = Math.cos(T);
const EX = 5.625;

export function stepFlashing() {
  const svg = new Svg({
    id: 'step', scale: 9.2, origin: [470, 610],
    title: 'Step flashing and kick-out flashing at a roof-to-wall joint',
    desc: 'A roof running into the side of a two-story wall, with the siding cut away. Ice and water shield turns up the wall a few inches. An L-shaped piece of step flashing goes in with every course of shingles: one leg on the roof under the next shingle, one leg up the wall, each piece lapping the one below. At the bottom, where the eave meets the wall, a kick-out flashing turns the water out and into the gutter so it cannot run down behind the siding. The housewrap laps over the flashing legs and the siding goes on over that, held up off the roof.',
  });
  const X1 = 32, UL = 42, D = 0.6;
  const R = roofPlane([0, 0, 0], PITCH);
  const YM = UL * COS, zr = (y) => Math.max(y, 0) * TAN;
  const wall = (y, z) => [0, y, z];
  const ABOVE = 18, BOT = -16, YF = -12;
  const tz = (y) => zr(y) + ABOVE;
  // wall: in front of the eave it runs down past the roof; behind, only above the roof line
  const wallPoly = [[YF, BOT], [0, BOT], [0, 0], [YM, zr(YM)], [YM, tz(YM)], [0, tz(0)], [YF, tz(0)]];
  const clipId = svg.nid('wall');
  svg.def(`<clipPath id="${clipId}"><polygon points="${wallPoly.map(([y, z]) => svg.P(wall(y, z)).map((n) => Math.round(n * 10) / 10).join(',')).join(' ')}"/></clipPath>`);
  svg.add(svg.poly(wallPoly.map(([y, z]) => wall(y, z)), C.sheath, {}));
  const yCut = 12, ySide = 25;
  const wrapPoly = [[YF, BOT], [-0.6, BOT], [-0.6, 7], [yCut, zr(yCut) + 7], [yCut, zr(yCut)], [YM, zr(YM)], [YM, tz(YM)], [0, tz(0)], [YF, tz(0)]];
  svg.add(svg.poly(wrapPoly.map(([y, z]) => wall(y, z)), C.wrap, {}));
  const lap = 6;
  let sid = `<g clip-path="url(#${clipId})">`;
  for (let z = BOT; z < tz(YM); z += lap) {
    const z1 = z + lap;
    if (z < tz(0)) {
      sid += svg.poly([wall(YF, z), wall(-1.4, z), wall(-1.4, z1), wall(YF, z1)], C.siding, { sw: 0.7 });
      sid += svg.line3(wall(YF, z + 0.6), wall(-1.4, z + 0.6), C.sidingShadow, 2);
    }
    const ye = Math.min(YM, (z - 2) / TAN);          // stop 2 in above the roof line
    if (ye > ySide + 0.3) {
      sid += svg.poly([wall(ySide, z), wall(ye, z), wall(ye, z1), wall(ySide, z1)], C.siding, { sw: 0.7 });
      sid += svg.line3(wall(ySide, z + 0.6), wall(ye, z + 0.6), C.sidingShadow, 2);
    }
  }
  svg.add(sid + '</g>');
  svg.add(svg.path3([wall(YF, tz(0)), wall(0, tz(0)), wall(YM, tz(YM))], C.ink, 2.2));
  // ice & water shield turned up the wall 5 in (shows in the cut-away)
  const hb = D + 0.18;
  const iw = (u, dz) => { const p = R(0, u, hb); return [0.04, p[1], p[2] + dz]; };
  svg.add(svg.poly([iw(0, 0), iw(UL, 0), iw(UL, 5), iw(0, 5)], C.ice, {}));
  // step flashing wall legs (each laps the one below)
  const nC = 8, ub = (i) => -0.5 + i * EX, hh = hb + 0.36;
  const pieces = [];
  for (let i = 0; i < nC - 1; i++) { const f0 = ub(i + 1) + 0.25; pieces.push([f0, f0 + 7.6]); }
  for (const [f0, f1] of pieces) {
    const a = R(0.08, f0, hh), b = R(0.08, f1, hh);
    svg.add(svg.poly([a, b, [0.08, b[1], b[2] + 5], [0.08, a[1], a[2] + 5]], shade(C.metal, [1, 0, 0]), { sw: 0.9 }));
  }
  // housewrap lapping OVER the legs from yCut up
  svg.add(svg.poly([[0.14, yCut, zr(yCut) + 1], [0.14, YM, zr(YM) + 1], [0.14, YM, zr(YM) + 7.5], [0.14, yCut, zr(yCut) + 7.5]], C.wrap, {}));
  svg.add(svg.line3([0.14, yCut, zr(yCut) + 1], [0.14, YM, zr(YM) + 1], C.wrapLine, 1.3));
  // gutter + fascia along the eave
  const gz = -7.6;
  svg.add(extrudeX(svg, [[-0.75, -6.9], [0, -6.9], [0, -0.1], [-0.75, -0.1]], 0.2, X1, '#f4f1ea', {}));
  svg.add(extrudeX(svg, [[-6.2, gz - 5], [-1.2, gz - 5], [-0.9, gz + 0.6], [-1.7, gz + 0.6], [-1.9, gz - 4.2], [-5.6, gz - 4.2], [-6.5, gz + 0.3], [-7.4, gz + 0.6]], 1.4, X1, C.gutter, { cap: '#e7e6e1' }));
  // deck + ice barrier
  svg.add(svg.box(R, 0.2, X1, 0, UL, 0, D, C.osb, {}));
  svg.add(flakes(svg, R, 1, X1 - 1, 1, UL - 1, D, 110));
  svg.add(svg.box(R, 0.2, X1 - 3, 0, UL, D, hb, C.ice, {}));
  // shingle courses + roof legs (upper courses cut back from the wall)
  for (let i = 0; i < nC; i++) {
    const a0 = i >= 3 ? 7 : 0.2;
    svg.add(shingleCourses(svg, R, { a0, a1: X1 - 8, uStart: ub(i), n: 1, h: hb, t: 0.34, seed: 40 + i }));
    if (i < nC - 1) {
      const [f0, f1] = pieces[i];
      svg.add(svg.poly([R(0.08, f0, hh), R(5, f0, hh), R(5, f1, hh), R(0.08, f1, hh)], shade(C.metal, R.e3), { sw: 0.9 }));
    }
  }
  // kick-out flashing at the eave end of the wall
  const kz = R(0, 0, hh)[2];
  svg.add(svg.poly([[0.1, 6, zr(6) + 5.4], [0.1, 6, zr(6) + 0.8], [0.1, -1.2, kz - 3.2], [0.1, -1.2, kz + 3.2]], shade(C.metal, [1, 0, 0]), { sw: 1 }));
  const fin = [[0.1, -1.2, kz - 3.2], [0.1, -1.2, kz + 3.2], [4.4, -3.6, kz + 2], [4.6, -3.9, kz - 2.6]];
  svg.add(svg.poly(fin, shade(C.metal, [0.5, -0.8, 0.2]), { stroke: C.orange, sw: 2.6 }));
  // water path
  svg.add(svg.path3([R(2.3, 28, hh + 1), R(2.3, 12, hh + 0.9), R(2.5, 2.5, hh + 0.8), [3.4, -2.8, kz - 1.2], [4.2, -4.2, gz - 2]], C.water, 3, ' stroke-dasharray="1 7"'));

  svg.top(svg.callout(1, R(3, pieces[4][0] + 3.5, hh), [935, 330], 'Step flashing', ['One L-shaped piece per course:', '5 in on the roof, 5 in up the wall']));
  svg.top(svg.callout(2, [0.08, R(0, pieces[2][1] - 1, hh)[1], R(0, pieces[2][1] - 1, hh)[2] + 3], [330, 420], 'Each piece laps', ['the one below 2 in'], { side: 'left' }));
  svg.top(svg.callout(3, [3, -2.9, kz - 0.3], [330, 700], 'Kick-out flashing', ['Code item: turns roof water', 'out into the gutter'], { side: 'left' }));
  svg.top(svg.callout(4, [0.14, 20, zr(20) + 5.5], [935, 200], 'Housewrap laps OVER', ['the flashing legs']));
  svg.top(svg.callout(5, [0, 33, zr(33) + 12], [330, 240], 'Siding', ['Over the wrap, held', 'up off the shingles'], { side: 'left' }));
  svg.top(svg.callout(6, iw(5, 2.5), [330, 560], 'Ice & water shield', ['Turned up the wall', 'at least 5 in'], { side: 'left' }));
  svg.top(svg.callout(7, [X1 - 8, -3.9, gz - 4.3], [935, 760], 'Gutter', ['Catches what the', 'kick-out sends it']));
  return svg.render({
    eyebrow: 'How it’s built · Roof meets wall', heading: 'Step flashing every course. Kick-out at the end.',
    footnote: 'Per GAF Timberline HDZ/UHDZ instructions · OH & KY R903.2.1, R905.2.8.3',
  });
}
