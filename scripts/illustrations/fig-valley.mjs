// #5 valleys (open metal vs closed-cut) and #16 ice & water shield in
// valleys and at penetrations. Two roof planes meet at an inside corner:
//   plane A: eave along +x (y = 0), rises toward +y, covers x >= -y
//   plane B: eave along -y (x = 0), rises toward -x, covers y <= -x
// so the valley runs from the eave corner (0,0) up the line y = -x.
import { Svg, C, shade, r1 } from './lib.mjs';

const P6 = 0.5, EX = 5.625;
const zA = (x, y) => y * P6, zB = (x, y) => -x * P6;
// a point on plane A / B, lifted h inches straight up (thin layers)
const A = (x, y, h = 0) => [x, y, zA(x, y) + h];
const B = (x, y, h = 0) => [x, y, zB(x, y) + h];
const NA = [0, -P6, 1], NB = [P6, 0, 1];

function rnd(seed) { let r = seed; return () => { r = (r * 9301 + 49297) % 233280; return r / 233280; }; }

// Shingle courses on plane A, left end following x = -y + off(y).
function coursesA(svg, { off, X, n, h, seed, start = -0.5 }) {
  let s = ''; const rand = rnd(seed);
  for (let i = 0; i < n; i++) {
    const y0 = start + i * EX, y1 = y0 + EX, xl = (y) => -y + off(y);
    s += svg.poly([A(xl(y0), y0, h), A(X, y0, h), A(X, y1 + 7.6, h), A(xl(y1 + 7.6), y1 + 7.6, h)], C.shingle, { sw: 0.6 });
    s += svg.poly([A(xl(y0), y0, h), A(X, y0, h), A(X, y1, h), A(xl(y1), y1, h)], C.shingleShadow, { stroke: null });
    let a = xl(y0) - rand() * 10;
    while (a < X) {
      const w = 5 + rand() * 7, g = 1.1 + rand() * 1.8;
      const L0 = Math.max(a, xl(y0)), L1 = Math.max(a, xl(y1)), R0 = Math.min(a + w, X);
      if (R0 > L0 + 0.3 && R0 > L1 + 0.3) {
        const tone = [C.shingle, C.shingleLight, '#545d68', '#47505a'][Math.floor(rand() * 4)];
        s += svg.poly([A(L0, y0, h), A(R0, y0, h), A(R0, y1, h), A(L1, y1, h)], tone, { stroke: null });
      }
      a += w + g;
    }
    s += svg.line3(A(xl(y0), y0, h), A(X, y0, h), C.ink, 1);
  }
  return s;
}
// Shingle courses on plane B (courses run along y; up-slope is -x), right
// end following y = -x - off(x).
function coursesB(svg, { off, Y, n, h, seed, start = 0.5 }) {
  let s = ''; const rand = rnd(seed);
  for (let i = 0; i < n; i++) {
    const x0 = start - i * EX, x1 = x0 - EX, yr = (x) => -x - off(x);
    s += svg.poly([B(x0, Y, h), B(x0, yr(x0), h), B(x1 - 7.6, yr(x1 - 7.6), h), B(x1 - 7.6, Y, h)], C.shingle, { sw: 0.6 });
    s += svg.poly([B(x0, Y, h), B(x0, yr(x0), h), B(x1, yr(x1), h), B(x1, Y, h)], C.shingleShadow, { stroke: null });
    let a = Y - rand() * 10;
    while (a < yr(x0)) {
      const w = 5 + rand() * 7, g = 1.1 + rand() * 1.8;
      const L = Math.max(a, Y), R0 = Math.min(a + w, yr(x0)), R1 = Math.min(a + w, yr(x1));
      if (R0 > L + 0.3 && R1 > L + 0.3) {
        const tone = [C.shingle, C.shingleLight, '#545d68', '#47505a'][Math.floor(rand() * 4)];
        s += svg.poly([B(x0, L, h), B(x0, R0, h), B(x1, R1, h), B(x1, L, h)], tone, { stroke: null });
      }
      a += w + g;
    }
    s += svg.line3(B(x0, Y, h), B(x0, yr(x0), h), C.ink, 1);
  }
  return s;
}

// Deck + underlayment for both planes, cut square at the top.
function decks(svg, { L, X, Y }) {
  let s = '';
  s += svg.poly([B(0, Y), B(0, 0), B(-L, L), B(-L, Y)], shade(C.osb, NB), {});
  s += svg.poly([A(0, 0), A(X, 0), A(X, L), A(-L, L)], shade(C.osb, NA), {});
  // fascia edges (front of A, right of B)
  s += svg.poly([A(0, 0), A(X, 0), [X, 0, -5], [0, 0, -5]], shade('#f4f1ea', [0, -1, 0]), {});
  s += svg.poly([B(0, Y), B(0, 0), [0, 0, -5], [0, Y, -5]], shade('#f4f1ea', [1, 0, 0]), {});
  return s;
}

const L = 50, X = 30, Y = -30, NC = 7;
function valleyPanel(svg, { dx, kind }) {
  let s = `<g transform="translate(${dx} 0)">` + decks(svg, { L, X, Y });
  const h1 = 0.25;
  if (kind === 'open') {
    // leak barrier (full-width roll) centred, then the metal liner
    s += svg.poly([B(-0.01, -18), A(18, 0), A(-L + 18, L), B(-L - 18, L)].map((p) => [p[0], p[1], p[2] + 0.08]), C.ice, { op: 0.98 });
    const w = 12; // half of 24 in metal (code minimum for open metal valleys)
    s += svg.poly([B(-0.01, -w, h1), A(w, 0, h1), A(-L + w, L, h1), B(-L - w, L, h1)], shade(C.metal, [0.25, -0.25, 1]), { sw: 1 });
    s += svg.line3(A(0, 0, h1 + 0.05), A(-L, L, h1 + 0.05), C.metalDark, 1.2);
    // shingles cut back: 6 in apart at the top, widening 1/8 in per foot toward the eave
    const half = (u) => 3 + (L - u) / 12 * 0.125 * 0.5 * 8; // drawn a little exaggerated so the taper shows
    s += coursesB(svg, { off: (x) => half(-x), Y, n: NC, h: h1 + 0.3, seed: 3 });
    s += coursesA(svg, { off: (y) => half(y), X, n: NC, h: h1 + 0.3, seed: 6 });
  } else {
    s += svg.poly([B(-0.01, -18), A(18, 0), A(-L + 18, L), B(-L - 18, L)].map((p) => [p[0], p[1], p[2] + 0.08]), C.ice, { op: 0.98 });
    // plane B shingles run across the valley onto plane A (12 in past the centre)
    s += coursesB(svg, { off: () => -0.01, Y, n: NC, h: h1, seed: 3 });
    // ...shown as a band on plane A where they lap over
    const rand = rnd(9);
    for (let i = 0; i < NC; i++) {
      const x0 = 0.5 - i * EX; void rand;
      const yy = -x0;
      s += svg.poly([A(x0, yy, h1), A(x0 + 12, yy, h1), A(x0 + 12 - EX, yy + EX, h1), A(x0 - EX, yy + EX, h1)].map((p) => p), shade(C.shingleDark, NA), { sw: 0.5, op: 0.9 });
    }
    // plane A shingles cut 2 in back from the valley centreline
    s += coursesA(svg, { off: () => 2, X, n: NC, h: h1 + 0.35, seed: 6 });
    s += svg.line3(A(2, 0, h1 + 0.5), A(-L + 2, L, h1 + 0.5), C.orange, 1.6, ' stroke-dasharray="5 4"');
    // no nails within 6 in of the centreline
    s += svg.poly([A(6, 0, h1 + 0.6), A(-L + 6, L, h1 + 0.6), B(-L - 6, L, h1 + 0.6), B(0, -6, h1 + 0.6)], C.orange, { stroke: null, op: 0.12 });
  }
  return s + '</g>';
}

export function valleys() {
  const svg = new Svg({
    id: 'valley', scale: 4.5, origin: [300, 690],
    title: 'Roof valleys: open metal valley and closed-cut valley',
    desc: 'Two ways to build a valley where two roof slopes meet. Left: an open valley, with ice and water shield under a metal valley liner; the shingles on both sides are cut back so the metal shows, narrowest at the top and widening toward the eave. Right: a closed-cut valley, with ice and water shield centred in the valley; the shingles from one slope run across the valley, and the shingles from the other slope are cut in a straight line 2 inches back from the valley centre, with no nails within 6 inches of the centre. A fully woven valley is not one of the methods the GAF or TAMKO instructions show for these laminated shingles, so NBD does not weave valleys.',
  });
  const DX = 560;
  svg.add(valleyPanel(svg, { dx: 0, kind: 'open' }));
  svg.add(valleyPanel(svg, { dx: DX, kind: 'closed' }));
  const q = (x, y, z) => svg.P([x, y, z]);
  void q; void r1;
  svg.top(`<text class="ntb" x="300" y="150" text-anchor="middle">OPEN METAL VALLEY</text><text class="ntb" x="860" y="150" text-anchor="middle">CLOSED-CUT VALLEY</text>`);
  const at = (dx, p) => { const q = svg.P(p); return [q[0] + dx, q[1]]; };
  svg.top(svg.callout(1, at(0, A(-30, 30 + 4, 0.4)), [70, 205], 'Metal valley liner', ['24 in wide min. (code);', 'nailed only at its edges']));
  svg.top(svg.callout(2, at(0, A(-26, 26 + 7, 0.6)), [350, 205], 'Shingles cut back', ['6 in apart at the top, a little', 'wider toward the eave']));
  svg.top(svg.callout(3, at(0, B(-44, 37, 0.12)), [70, 800], 'Ice & water shield', ['Under the whole valley']));
  svg.top(svg.callout(4, at(DX, B(-30, 10, 0.5)), [640, 800], 'One side runs across', ['at least 12 in past', 'the centreline']));
  svg.top(svg.callout(5, at(DX, A(-40 + 2, 40, 0.8)), [640, 205], 'Other side cut', ['2 in back from', 'the centreline']));
  svg.top(svg.callout(6, at(DX, A(-14 + 5, 14, 0.8)), [940, 205], 'No nails', ['within 6 in of', 'the centre']));
  return svg.render({
    eyebrow: 'How it’s built · Valleys', heading: 'Where two slopes meet, the water doubles.',
    footnote: 'Per GAF Timberline HDZ/UHDZ & TAMKO Heritage instructions · OH & KY R905.2.8.2',
  });
}

// #16 — ice & water shield in the valley, at the eaves and around a chimney.
export function iwsValleys() {
  const svg = new Svg({
    id: 'iws', scale: 5.0, origin: [560, 690],
    title: 'Where ice and water shield goes besides the eaves',
    desc: 'A roof with the shingles left off so the layers underneath show. A full-width sheet of ice and water shield is centred in the valley, and the regular underlayment on both slopes laps at least 6 inches over its edges. Ice and water shield also runs along the eaves, and around the chimney it covers the deck and turns up the chimney sides at least 5 inches before the step and counter flashing go on.',
  });
  const L = 56, X = 66, Y = -36;
  svg.add(decks(svg, { L, X, Y }));
  const h = 0.12;
  // eave strips (both planes)
  svg.add(svg.poly([A(-0.01, 0, h), A(X, 0, h), A(X, 18, h), A(-18, 18, h)], C.ice, {}));
  svg.add(svg.poly([B(0, Y, h), B(0, 0, h), B(-18, 18, h), B(-18, Y, h)], C.ice, {}));
  // valley sheet: 36 in wide, centred
  const w = 18;
  svg.add(svg.poly([B(-0.01, -w, h + 0.05), A(w, 0, h + 0.05), A(-L + w, L, h + 0.05), B(-L - w, L, h + 0.05)], shade(C.ice, [0.2, -0.2, 1]), {}));
  svg.add(svg.line3(A(0, 0, h + 0.1), A(-L, L, h + 0.1), C.iceGrain, 1, ' stroke-dasharray="4 4"'));
  // underlayment on both slopes, lapping 6 in over the valley sheet and the eave strips
  const lapA = (y) => -y + (w - 6);
  svg.add(svg.poly([A(lapA(12), 12, h + 0.2), A(X, 12, h + 0.2), A(X, L, h + 0.2), A(lapA(L), L, h + 0.2)], C.under, {}));
  for (const y of [24, 36, 48]) svg.add(svg.line3(A(lapA(y) + 0.5, y, h + 0.25), A(X - 0.5, y, h + 0.25), C.underLine, 1, ' stroke-dasharray="6 4"'));
  const lapB = (x) => -x - (w - 6);
  svg.add(svg.poly([B(-12, Y, h + 0.2), B(-12, lapB(-12), h + 0.2), B(-L + 2, lapB(-L + 2), h + 0.2), B(-L + 2, Y, h + 0.2)], C.under, {}));
  // chimney on plane A: ice & water around its base and up its sides
  const cx0 = 30, cx1 = 52, cy0 = 26, cy1 = 40, ch = 34;
  svg.add(svg.poly([A(cx0 - 6, cy0 - 6, h + 0.3), A(cx1 + 6, cy0 - 6, h + 0.3), A(cx1 + 6, cy1 + 6, h + 0.3), A(cx0 - 6, cy1 + 6, h + 0.3)], C.ice, {}));
  const top = zA(0, cy1) + ch;
  const brickF = [A(cx0, cy0), A(cx1, cy0), [cx1, cy0, top], [cx0, cy0, top]];
  const brickR = [A(cx1, cy0), A(cx1, cy1), [cx1, cy1, top], [cx1, cy0, top]];
  svg.add(svg.poly(brickF, shade(C.brick, [0, -1, 0]), {}));
  svg.add(svg.poly(brickR, shade(C.brick, [1, 0, 0]), {}));
  svg.add(svg.poly([[cx0, cy0, top], [cx1, cy0, top], [cx1, cy1, top], [cx0, cy1, top]], shade('#8e8a85', [0, 0, 1]), {}));
  for (let z = zA(0, cy0) + 2.5; z < top; z += 2.6) svg.add(svg.line3([cx0, cy0, z], [cx1, cy0, z], '#8f4a35', 0.7));
  for (let z = zA(0, cy0) + 2.5; z < top; z += 2.6) svg.add(svg.line3([cx1, cy0, z], [cx1, cy1, z + (z < zA(0, cy1) ? 0 : 0)], '#8f4a35', 0.7));
  // membrane turned up the sides 5 in
  svg.add(svg.poly([A(cx0, cy0, 0.3), A(cx1, cy0, 0.3), [cx1, cy0, zA(0, cy0) + 5], [cx0, cy0, zA(0, cy0) + 5]], shade(C.ice, [0, -1, 0]), {}));
  svg.add(svg.poly([A(cx1, cy0, 0.3), A(cx1, cy1, 0.3), [cx1, cy1, zA(0, cy1) + 5], [cx1, cy0, zA(0, cy0) + 5]], shade(C.ice, [1, 0, 0]), {}));

  svg.top(svg.callout(1, A(-30, 30, h + 0.1), [70, 300], 'Valley: full-width sheet', ['Centred on the valley line']));
  svg.top(svg.callout(2, A(lapA(30) + 2, 30, h + 0.2), [70, 190], 'Underlayment laps over it', ['at least 6 in on each side']));
  svg.top(svg.callout(3, A(50, 8, h), [960, 800], 'Eaves', ['24 in+ past the wall line']));
  svg.top(svg.callout(4, [cx1, cy0 + 4, zA(0, cy0 + 4) + 3], [960, 300], 'Up the chimney sides', ['at least 5 in, before the', 'step & counter flashing']));
  svg.top(svg.callout(5, A(cx1 + 3, cy1 + 3, h + 0.3), [960, 440], 'Around the base', ['Covers the deck under', 'the flashing']));
  return svg.render({
    eyebrow: 'How it’s built · Ice & water shield', heading: 'Not just the eaves: valleys and chimneys too.',
    footnote: 'Per GAF Timberline HDZ/UHDZ & TAMKO Heritage instructions · OH & KY R905.1.2',
  });
}
