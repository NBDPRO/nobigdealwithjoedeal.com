// #7 — hail impact: UL 2218 Class 4 vs a standard architectural shingle.
// Illustrative only: no "hail proof" claims.
import { Svg, C, frame, r1 } from './lib.mjs';

function sample(svg, F, { cracked }) {
  const W = 9, Dp = 7;
  let s = '';
  // deck, underlayment, two shingle layers (thicknesses exaggerated)
  s += svg.box(F, 0, W, 0, Dp, 0, 1.0, C.osb, {});
  s += svg.box(F, 0, W, 0, Dp, 1.0, 1.15, C.under, {});
  s += svg.box(F, 0, W, 0, Dp, 1.15, 2.0, C.shingleDark, {});
  s += svg.box(F, 0, W, 0, Dp, 2.0, 2.9, C.shingle, {});
  // fibreglass mat lines on the cut faces
  for (const z of [1.55, 2.45]) {
    s += svg.line3(F(0, 0, z), F(W, 0, z), '#d9d4c4', 1.6);
    s += svg.line3(F(W, 0, z), F(W, Dp, z), '#d9d4c4', 1.6);
  }
  // granules (top)
  let r = cracked ? 5 : 9; const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  for (let i = 0; i < 160; i++) { const p = svg.P(F(rand() * W, rand() * Dp, 2.9)); s += `<circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="${r1(0.8 + rand() * 1.1)}" fill="${rand() < 0.5 ? '#6b7480' : '#2f353d'}"/>`; }
  const c = svg.P(F(W / 2, Dp / 2, 2.9));
  if (cracked) {
    // bruise: granules knocked off, dark spot, cracks through the mat on the cut face
    s += `<ellipse cx="${r1(c[0])}" cy="${r1(c[1])}" rx="30" ry="16" fill="#1c2026"/>`;
    s += `<ellipse cx="${r1(c[0])}" cy="${r1(c[1] + 2)}" rx="18" ry="9" fill="#111417"/>`;
    const f0 = svg.P(F(W / 2, 0, 2.9)), f1 = svg.P(F(W / 2 + 0.3, 0, 1.2));
    s += `<path d="M${r1(f0[0])} ${r1(f0[1])}l6 9-7 8 5 10-4 7" fill="none" stroke="#f3efe6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    s += `<path d="M${r1(f0[0])} ${r1(f0[1])}l6 9-7 8 5 10-4 7" fill="none" stroke="${C.ink}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`;
    void f1;
  } else {
    s += `<ellipse cx="${r1(c[0])}" cy="${r1(c[1])}" rx="22" ry="11" fill="none" stroke="#7f8894" stroke-width="1.6" stroke-dasharray="3 3"/>`;
  }
  return { s, top: c };
}

function ball(cx, cy, rad, id) {
  return `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(rad)}" fill="url(#${id}-ball)" stroke="${C.ink}" stroke-width="1.2"/>`;
}

export function hailImpact() {
  const svg = new Svg({
    id: 'hail', scale: 26, origin: [215, 500],
    title: 'Hail impact: a UL 2218 Class 4 shingle next to a standard shingle',
    desc: 'An illustration of what the UL 2218 impact test measures. Steel balls are dropped on a shingle twice in the same spot; Class 1 uses a 1 and 1/4 inch ball and Class 4, the top rating, a 2 inch ball, and a shingle earns the class only if no crack shows on the back. On the left, a hard hit cracks through the fibreglass mat of a shingle that is not impact-rated. On the right, a Class 4 shingle such as GAF Timberline UHDZ takes the same size hit with only a mark. This is an illustration of a lab test, not a promise: hail bigger or harder than the test can still damage any roof.',
  });
  svg.def(`<radialGradient id="hail-ball" cx="35%" cy="32%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#b9c0c8"/><stop offset="1" stop-color="#5b636d"/></radialGradient>`);
  const FL = frame([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  const DX = 520;
  const L = sample(svg, FL, { cracked: true }), R0 = sample(svg, FL, { cracked: false });
  const R = { s: R0.s, top: [R0.top[0] + DX, R0.top[1]] };
  svg.add(L.s + `<g transform="translate(${DX} 0)">${R0.s}</g>`);
  // the 2 in test ball over each sample (drawn to the same scale)
  const br = 1 * 26;
  for (const t of [L.top, R.top]) {
    svg.add(`<line x1="${r1(t[0])}" y1="${r1(t[1] - 170)}" x2="${r1(t[0])}" y2="${r1(t[1] - br - 30)}" stroke="${C.ink}" stroke-width="1.2" stroke-dasharray="4 5"/>`);
    svg.add(ball(t[0], t[1] - br - 8, br, 'hail'));
  }
  svg.add(`<path d="M${r1(R.top[0] + 34)} ${r1(R.top[1] - 70)}c18-14 26-36 18-60" fill="none" stroke="${C.ink}" stroke-width="1.4" marker-end="url(#hail-ar2)"/>`);
  svg.def(`<marker id="hail-ar2" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1L9 5L1 9z" fill="${C.ink}"/></marker>`);
  svg.top(`<text class="ntb" x="${r1(L.top[0])}" y="190" text-anchor="middle">NOT IMPACT-RATED</text><text class="nt" x="${r1(L.top[0])}" y="212" text-anchor="middle">Standard architectural shingle</text>`);
  svg.top(`<text class="ntb" x="${r1(R.top[0])}" y="190" text-anchor="middle">UL 2218 CLASS 4</text><text class="nt" x="${r1(R.top[0])}" y="212" text-anchor="middle">e.g. GAF Timberline UHDZ</text>`);
  svg.top(svg.callout(1, [L.top[0] + 14, L.top[1] + 70], [150, 650], 'A hard hit can crack the mat', ['Granules knocked loose; the crack', 'is what lets water in later'], { side: 'right' }));
  svg.top(svg.callout(2, [R.top[0] + 20, R.top[1] + 4], [670, 650], 'Built to pass two 2 in hits', ['in the same spot with no crack', 'on the back (the lab test)'], { side: 'right' }));
  // ball sizes, true relative scale
  const by = 800, bx = 600;
  svg.top(`<text class="ntb" x="${bx - 20}" y="${by - 60}" text-anchor="end">UL 2218 test balls</text><text class="nt" x="${bx - 20}" y="${by - 38}" text-anchor="end">(to scale with each other)</text>`);
  [['1', 1.25], ['2', 1.5], ['3', 1.75], ['4', 2]].forEach(([k, dia], i) => {
    const x = bx + 30 + i * 120, rad = dia * 13;
    svg.top(ball(x, by - 50 + (26 - rad), rad, 'hail'));
    svg.top(`<text class="ntb" x="${x}" y="${by}" text-anchor="middle">Class ${k}</text><text class="nt" x="${x}" y="${by + 20}" text-anchor="middle">${dia === 1.25 ? '1¼' : dia === 1.5 ? '1½' : dia === 1.75 ? '1¾' : '2'} in</text>`);
  });
  svg.top(svg.note(40, 750, ['A lab rating, not a promise:', 'hail bigger or harder than the', 'test can still damage any roof.']));
  return svg.render({
    eyebrow: 'How it works · Impact rating', heading: 'What “Class 4” actually means.',
    footnote: 'UL 2218 test per Owens Corning Pub. 10028281 & NRCA Professional Roofing',
  });
}
