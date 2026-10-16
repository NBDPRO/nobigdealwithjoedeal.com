// #11 — seamless K-style gutter: hidden hangers, pitch, guard.
// The run goes away from the viewer (+y) so the cut end at y = 0 shows the
// K-style profile square-on; the house is to the left (-x).
import { Svg, C, extrudeY, r1, shade } from './lib.mjs';

export function gutterSection() {
  const svg = new Svg({
    id: 'gut', scale: 17, origin: [470, 500],
    title: 'A seamless gutter with hidden hangers and a guard',
    desc: 'A cutaway of a seamless K-style aluminum gutter hung on the fascia. Hidden hangers clip into the front lip and screw through the back of the gutter into the fascia; Gentek, one gutter maker, calls for hangers no more than 32 inches apart. The drip edge and shingles hang over into the gutter so roof water drops in. The gutter slopes toward the downspout at least a quarter inch for every 10 feet. A gutter guard covers the top to keep leaves out.',
  });
  const L = 34;                                         // run shown (y), hangers at 1 and 33
  const sl = 0.5;                                       // 6:12 roof rising toward -x
  const top = (x, h) => -x * sl + h;                    // roof surface line, eave edge at x = 0
  // fascia board (front cap = section)
  svg.add(extrudeY(svg, [[-0.75, -7.2], [0, -7.2], [0, 0], [-0.75, 0]], 0, L, '#f4f1ea', {}));
  // deck, ice barrier, starter, shingle (section profiles extruded along the run)
  const slab = (h0, h1, x0, col, x1 = -6) => extrudeY(svg, [[x0, top(x0, h0)], [x1, top(x1, h0)], [x1, top(x1, h1)], [x0, top(x0, h1)]].reverse(), 0, L, col, {});
  svg.add(slab(0.05, 0.65, 0, C.osb));
  // drip edge: on the deck, down over the fascia, kicked out over the gutter
  const de = [[-2.4, top(-2.4, 0.7)], [0.08, top(0.08, 0.7)], [0.25, -1.6], [0.85, -2.05]];
  for (let i = 0; i < de.length - 1; i++) {
    const [a, b] = [de[i], de[i + 1]];
    svg.add(svg.poly([[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], L, b[1]], [a[0], L, a[1]]], shade(C.metal, [b[1] - a[1], 0, -(b[0] - a[0])]), { sw: 0.7 }));
  }
  svg.add(svg.path3(de.map(([x, z]) => [x, 0, z]), C.ink, 2.6));
  svg.add(slab(0.75, 0.95, -0.05, C.ice));
  svg.add(slab(0.95, 1.25, 0.5, C.starter, -5));
  svg.add(slab(1.25, 1.62, 0.5, C.shingle));
  for (let y = 4; y < L; y += 9) svg.add(svg.line3([0.5, y, top(0.5, 1.62)], [-6, y, top(-6, 1.62)], C.shingleShadow, 1.2));
  // the gutter (open sheet): back on the fascia, flat bottom, K-style front, lip
  const g = [[0.05, -0.8], [0.05, -6.3], [3.4, -6.3], [3.7, -5.6], [4.5, -5.1], [4.4, -3.6], [5.1, -2.9], [5.1, -0.9], [4.5, -0.8]];
  svg.add(svg.poly([[0.06, 0, -0.8], [0.06, L, -0.8], [0.06, L, -6.3], [0.06, 0, -6.3]], '#ecebe6', {}));
  svg.add(svg.poly([[0.06, 0, -6.3], [3.4, 0, -6.3], [3.4, L, -6.3], [0.06, L, -6.3]], '#dfddd7', {}));
  svg.add(svg.poly([[0.3, 2, -6.25], [3.2, 2, -6.25], [3.2, L - 1, -6.15], [0.3, L - 1, -6.15]], C.water, { stroke: null, op: 0.4 }));
  { const c = svg.P([1.8, L - 3, -6.28]); svg.add(`<ellipse cx="${r1(c[0])}" cy="${r1(c[1])}" rx="22" ry="11" fill="#4a5058" stroke="${C.ink}" stroke-width="1"/>`); }
  svg.add(svg.path3([[1.8, 4, -6.0], [1.8, L - 6, -5.9]], C.water, 3.2, ` marker-end="url(#gut-wa)"`));
  svg.def(`<marker id="gut-wa" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M1 1L9 5L1 9z" fill="${C.water}"/></marker>`);
  // hidden hangers 32 in apart (Gentek's maximum spacing)
  for (const hy of [1, 33]) {
    svg.add(svg.poly([[0.1, hy - 0.5, -1.45], [4.75, hy - 0.5, -0.95], [4.75, hy + 0.5, -0.95], [0.1, hy + 0.5, -1.45]], shade('#a3acb6', [0, 0, 1]), { sw: 1 }));
    svg.add(svg.poly([[4.75, hy - 0.5, -0.95], [4.95, hy - 0.5, -1.4], [4.95, hy + 0.5, -1.4], [4.75, hy + 0.5, -0.95]], '#7f8994', { sw: 0.8 }));
    const sc = svg.P([0.2, hy, -1.7]);
    svg.add(`<circle cx="${r1(sc[0])}" cy="${r1(sc[1])}" r="5" fill="#6f7884" stroke="${C.ink}" stroke-width="1.2"/>`);
  }
  // outside of the gutter (front faces)
  for (let i = 2; i < g.length - 1; i++) {
    const [a, b] = [g[i], g[i + 1]];
    let n = [-(b[1] - a[1]), 0, b[0] - a[0]];
    if (n[0] < 0) n = n.map((v) => -v);
    svg.add(svg.poly([[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], L, b[1]], [a[0], L, a[1]]], shade(C.gutter, n), { sw: 0.7 }));
  }
  // the cut end: profile drawn bold
  svg.add(svg.path3(g.map(([x, z]) => [x, 0, z]), C.ink, 3.4));
  // gutter guard over the near half (cut back to show the far hanger)
  const gz0 = -0.55, gz1 = -0.75;
  svg.add(svg.poly([[0.2, 0, gz0], [4.9, 0, gz1], [4.9, 18, gz1], [0.2, 18, gz0]], '#cdd1d6', { sw: 1, op: 0.94 }));
  for (let y = 0.7; y < 18; y += 0.7) svg.add(svg.line3([0.2, y, gz0], [4.9, y, gz1], '#9aa2ab', 0.6));
  for (let k = 1; k < 7; k++) { const x = 0.2 + 4.7 * (k / 7); svg.add(svg.line3([x, 0, gz0 + (gz1 - gz0) * (k / 7)], [x, 18, gz0 + (gz1 - gz0) * (k / 7)], '#9aa2ab', 0.6)); }
  // hanger spacing dimension along the run (just outside the front lip)
  svg.top(svg.dim([5.1, 1, -0.9], [5.1, 33, -0.9], [2.6, 0, 0], '32 in max.', { dx: 46, dy: 18 }));

  svg.top(svg.callout(1, [2.8, 33, -1.2], [960, 170], 'Hidden hangers', ['Clip the front lip, screw', 'through the back into the fascia']));
  svg.top(svg.callout(2, [0.2, 33, -1.7], [960, 300], 'Screwed into the fascia', ['Solid wood behind it']));
  svg.top(svg.callout(3, [0.6, 0, -1.9], [300, 430], 'Drip edge over the gutter', ['Roof water drops in,', 'not behind it'], { side: 'left' }));
  svg.top(svg.callout(4, [2.5, 9, -0.65], [300, 250], 'Gutter guard', ['Keeps leaves out; lifts', 'off for cleaning'], { side: 'left' }));
  svg.top(svg.callout(5, [5.1, 30, -2.2], [960, 420], 'Downspout outlet', ['The low end of the run']));
  svg.top(svg.callout(6, [4.4, 0, -3.6], [300, 640], 'Seamless K-style', ['One piece corner to corner;', '5 in or 6 in aluminum'], { side: 'left' }));
  const bx = 640, by = 670;
  svg.top(`<g><rect x="${bx}" y="${by}" width="520" height="140" rx="8" fill="#fbfaf7" stroke="${C.rule}" stroke-width="1.5"/>`
    + `<text class="ntb" x="${bx + 20}" y="${by + 32}">Pitch toward the downspout (exaggerated)</text>`
    + `<line x1="${bx + 40}" y1="${by + 62}" x2="${bx + 450}" y2="${by + 88}" stroke="${C.ink}" stroke-width="5" stroke-linecap="round"/>`
    + `<line x1="${bx + 40}" y1="${by + 62}" x2="${bx + 450}" y2="${by + 62}" stroke="${C.muted}" stroke-width="1" stroke-dasharray="4 4"/>`
    + `<rect x="${bx + 446}" y="${by + 86}" width="16" height="40" fill="${C.gutter}" stroke="${C.ink}" stroke-width="1.2"/>`
    + `<line x1="${bx + 476}" y1="${by + 62}" x2="${bx + 476}" y2="${by + 88}" stroke="${C.orange}" stroke-width="1.6" marker-start="url(#gut-ar)" marker-end="url(#gut-ar)"/>`
    + `<text class="dl" x="${bx + 250}" y="${by + 120}" text-anchor="middle">at least ¼ in drop per 10 ft</text>`
    + `</g>`);
  return svg.render({
    eyebrow: 'How it’s built · Gutters', heading: 'Hung right, pitched right.',
    footnote: 'Hanger spacing & pitch per Gentek aluminum rainware install guide',
  });
}
