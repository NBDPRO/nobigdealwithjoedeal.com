// #12 — what Joe checks on a storm inspection.
import { Svg, C, shade, frame, r1, esc } from './lib.mjs';

const I = frame([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);

export function stormChecklist() {
  const svg = new Svg({
    id: 'chk', scale: 1.38, origin: [120, 650],
    title: 'What Joe checks on a storm inspection',
    desc: 'A house with numbered spots showing what gets checked after a storm: the shingles on every slope for hail hits, creases and missing pieces; the ridge cap and roof vents; pipe boots and the flashing at chimneys, walls and valleys; gutters and downspouts; soft metals like vents and the air-conditioner fins, which show hail size; siding and window trim for dents and cracks; fascia and soffit; and the attic from inside when the homeowner is home, for stains, daylight and ventilation. Every finding is photographed.',
  });
  const W = 288, WALL = 108, OH = 16, D = 300, P = 0.5;
  const top = (x) => WALL + 8 + (x <= W / 2 ? x + OH : W - x + OH) * P;   // roof surface over x
  const ridgeZ = top(W / 2);
  // right side wall
  svg.add(svg.poly([[W, 0, 0], [W, D, 0], [W, D, WALL], [W, 0, WALL]], '#ddd6ca', {}));
  for (let z = 8; z < WALL; z += 8) svg.add(svg.line3([W, 0, z], [W, D, z], C.sidingShadow, 0.9));
  for (const [a, b] of [[50, 92], [190, 232]]) {
    svg.add(svg.poly([[W, a, 40], [W, b, 40], [W, b, 88], [W, a, 88]], '#fff', { sw: 1.3 }));
    svg.add(svg.poly([[W, a + 4, 44], [W, b - 4, 44], [W, b - 4, 84], [W, a + 4, 84]], '#a9bccf', { sw: 0.8 }));
  }
  // front gable wall with siding, door and windows
  const gable = [[0, 0, 0], [W, 0, 0], [W, 0, WALL], [W / 2, 0, WALL + (W / 2) * P], [0, 0, WALL]];
  svg.add(svg.poly(gable, C.siding, {}));
  for (let z = 8; z < WALL + W / 2 * P; z += 8) {
    const half = z <= WALL ? W / 2 : W / 2 - (z - WALL) / P;
    if (half > 1) svg.add(svg.line3([W / 2 - half, 0, z], [W / 2 + half, 0, z], C.sidingShadow, 0.9));
  }
  svg.add(svg.poly([[124, 0, 0], [164, 0, 0], [164, 0, 82], [124, 0, 82]], C.navy, {}));
  for (const [a, b] of [[34, 90], [198, 254]]) {
    svg.add(svg.poly([[a, 0, 40], [b, 0, 40], [b, 0, 88], [a, 0, 88]], '#fff', { sw: 1.3 }));
    svg.add(svg.poly([[a + 4, 0, 44], [b - 4, 0, 44], [b - 4, 0, 84], [a + 4, 0, 84]], '#a9bccf', { sw: 0.8 }));
  }
  // gable vent (attic)
  svg.add(svg.poly([[W / 2 - 14, 0, WALL + 34], [W / 2 + 14, 0, WALL + 34], [W / 2, 0, WALL + 56]], '#8f97a3', { sw: 1 }));
  // rake trim / fascia on the gable
  svg.add(svg.poly([[-OH, -1, top(-OH) - 6], [W / 2, -1, ridgeZ - 6], [W / 2, -1, ridgeZ], [-OH, -1, top(-OH)]], '#f4f1ea', {}));
  svg.add(svg.poly([[W / 2, -1, ridgeZ - 6], [W + OH, -1, top(W + OH) - 6], [W + OH, -1, top(W + OH)], [W / 2, -1, ridgeZ]], '#f4f1ea', {}));
  // roof slopes
  for (const [x0, x1, n] of [[-OH, W / 2, [-0.45, 0, 0.9]], [W / 2, W + OH, [0.45, 0, 0.9]]]) {
    svg.add(svg.poly([[x0, -1, top(x0)], [x1, -1, top(x1)], [x1, D, top(x1)], [x0, D, top(x0)]], shade(C.shingle, n), {}));
    for (let k = 9; k < W / 2 + OH; k += 9) { const x = x0 < 0 ? -OH + k : W + OH - k; svg.add(svg.line3([x, -1, top(x)], [x, D, top(x)], C.shingleShadow, 0.7)); }
  }
  // ridge vent / cap
  svg.add(svg.poly([[W / 2 - 7, 10, top(W / 2 - 7) + 2], [W / 2 + 7, 10, top(W / 2 + 7) + 2], [W / 2 + 7, D - 10, top(W / 2 + 7) + 2], [W / 2 - 7, D - 10, top(W / 2 - 7) + 2]], C.ridge, {}));
  // chimney (right slope) + pipe boot (right slope, nearer)
  const cx0 = 200, cx1 = 236, cy0 = 190, cy1 = 222, ch = ridgeZ + 22;
  svg.add(svg.poly([[cx0, cy0, top(cx0)], [cx1, cy0, top(cx1)], [cx1, cy0, ch], [cx0, cy0, ch]], shade(C.brick, [0, -1, 0]), {}));
  svg.add(svg.poly([[cx1, cy0, top(cx1)], [cx1, cy1, top(cx1)], [cx1, cy1, ch], [cx1, cy0, ch]], shade(C.brick, [1, 0, 0]), {}));
  svg.add(svg.poly([[cx0, cy0, ch], [cx1, cy0, ch], [cx1, cy1, ch], [cx0, cy1, ch]], '#8e8a85', {}));
  svg.add(svg.poly([[cx0 - 2, cy0 - 2, top(cx0 - 2) + 0.5], [cx1 + 2, cy0 - 2, top(cx1 + 2) + 0.5], [cx1 + 2, cy0 + 3, top(cx1 + 2) + 0.5], [cx0 - 2, cy0 + 3, top(cx0 - 2) + 0.5]], C.metal, { sw: 0.8 }));
  const bp = svg.P([250, 80, top(250)]);
  svg.add(`<ellipse cx="${r1(bp[0])}" cy="${r1(bp[1])}" rx="9" ry="5" fill="#3b4048" stroke="${C.ink}"/><rect x="${r1(bp[0] - 3.5)}" y="${r1(bp[1] - 14)}" width="7" height="14" fill="#e9e7e2" stroke="${C.ink}" stroke-width=".8"/>`);
  // box vent on the right slope
  const bv = svg.P([226, 120, top(226)]);
  svg.add(`<rect x="${r1(bv[0] - 10)}" y="${r1(bv[1] - 9)}" width="20" height="10" fill="#7f8792" stroke="${C.ink}" stroke-width=".8"/>`);
  // gutter along the right eave + downspout at the front corner
  const ge = W + OH;
  svg.add(svg.poly([[ge, -2, WALL + 1], [ge, D, WALL + 1], [ge, D, WALL + 7], [ge, -2, WALL + 7]], shade(C.gutter, [1, 0, 0]), {}));
  svg.add(svg.poly([[ge - 3, 4, 0], [ge + 1, 4, 0], [ge + 1, 4, WALL + 1], [ge - 3, 4, WALL + 1]], C.gutter, { sw: 0.9 }));
  // AC unit beside the house
  svg.add(svg.box(I, W + 22, W + 54, 30, 62, 0, 30, '#c7ccd2', {}));
  for (let z = 4; z < 28; z += 3) svg.add(svg.line3([W + 54, 31, z], [W + 54, 61, z], '#8d949d', 0.8));
  const items = [
    ['Shingles, every slope', 'Hail hits, creases, missing pieces', [80, 150, top(80)]],
    ['Ridge cap & roof vents', 'Cracks, lifted caps, dented vents', [W / 2, 150, ridgeZ + 2]],
    ['Flashing & pipe boots', 'Chimney, walls, valleys, boots', [cx0 + 10, cy0, top(cx0 + 10) + 3]],
    ['Gutters & downspouts', 'Dents, sags, pulled hangers', [ge, 120, WALL + 4]],
    ['Soft metals', 'Vents and AC fins show hail size', [W + 54, 46, 18]],
    ['Siding & window trim', 'Dents, cracks, holes', [W, 160, 60]],
    ['Fascia & soffit', 'Rot, gaps, loose trim', [W / 2 + 60, -1, top(W / 2 + 60) - 3]],
    ['The attic, if you’re home', 'Stains, daylight, ventilation', [W / 2, 0, WALL + 44]],
  ];
  const lx = 880;
  items.forEach(([t, sub, p], i) => {
    const q = svg.P(p);
    svg.top(`<g class="nb"><circle cx="${r1(q[0])}" cy="${r1(q[1])}" r="15"/><text x="${r1(q[0])}" y="${r1(q[1] + 6)}" text-anchor="middle">${i + 1}</text></g>`);
    const y = 150 + i * 72;
    svg.top(`<g class="lst"><circle cx="${lx}" cy="${y}" r="15" fill="${C.orange}" stroke="#fff" stroke-width="2.5"/><text class="lstn" x="${lx}" y="${y + 6}" text-anchor="middle" fill="#fff">${i + 1}</text></g>`);
    svg.top(`<text class="lbl" x="${lx + 26}" y="${y + 1}">${esc(t)}</text><text class="sub" x="${lx + 26}" y="${y + 21}">${esc(sub)}</text>`);
  });
  svg.top(svg.note(lx - 15, 735, ['Every finding gets photographed.', 'Free inspection; a written photo', 'report is $150 if you want one.']));
  return svg.render({
    eyebrow: 'How it works · After a storm', heading: 'What I check after a storm.',
    footnote: 'NBD storm inspection, 45–60 minutes',
  });
}
