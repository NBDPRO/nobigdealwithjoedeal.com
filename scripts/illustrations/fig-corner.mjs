// #3 rake edge and #15 starter-strip overhang: the eave/rake corner.
import { Svg, C, roofPlane, extrudeX, ribbonX, ribbonF, shingleCourses, flakes, hatchDef } from './lib.mjs';

const PITCH = 6;
const T = Math.atan(PITCH / 12), TAN = Math.tan(T);
const DECK = 0.6;

function corner(svg, { X1, UL, show }) {
  const R = roofPlane([0, -0.75, -0.75 * TAN], PITCH);
  const woodCut = hatchDef(svg, 'wood', C.woodDark, C.wood, 6);
  let s = '';
  // eave fascia (wraps to the rake board)
  s += extrudeX(svg, [[-0.75, -6.9], [0, -6.9], [0, -0.1], [-0.75, -0.1]], 0, X1 + 0.75, '#f4f1ea', {});
  // rake board: vertical board under the deck edge, along the slope
  const top0 = R(X1, 0, 0), top1 = R(X1, UL, 0);
  s += extrudeX(svg, [[top0[1], top0[2] - 6.6], [top1[1], top1[2] - 6.6], [top1[1], top1[2] + DECK], [top0[1], top0[2] + DECK]], X1, X1 + 0.75, '#f4f1ea', { cap: '#eeeae2' });
  // deck
  s += svg.box(R, 0, X1, 0, UL, 0, DECK, C.osb, { faces: { b1: woodCut } });
  s += flakes(svg, R, 0.5, X1 - 0.5, 0.5, UL - 0.5, DECK, Math.round(X1 * UL / 9));
  return { R, s };
}

// eave drip edge profile (y, z) for a deck whose eave edge is at y = -0.75
function eaveDrip(R) {
  const z = R(0, 0, DECK)[2], f = R(0, 2.5, DECK);
  return [[f[1], f[2] + 0.06], [-0.81, z + 0.06], [-0.98, z - 1.9], [-1.6, z - 2.3]];
}

// #3 — rake: underlayment first, drip edge over it.
export function rakeDetail() {
  const svg = new Svg({
    id: 'rake', scale: 11.5, origin: [250, 560],
    title: 'Roof rake edge, layer by layer',
    desc: 'A cutaway of the corner where the eave meets the sloped side edge (the rake). At the rake the order is the reverse of the eave: the underlayment runs out to the edge of the deck first, and the metal drip edge goes on top of it, turned down over the rake board. A starter strip runs up the rake over the drip edge, and the shingles finish flush over it.',
  });
  const X1 = 40, UL = 34;
  const { R, s } = corner(svg, { X1, UL });
  svg.add(s);
  const hU = DECK + 0.14;
  // eave drip edge (eave: on the deck, under the underlayment)
  svg.add(ribbonX(svg, eaveDrip(R), 0, X1 + 0.9, C.metal));
  // underlayment to the rake edge (cut back on the left to show the deck)
  svg.add(svg.box(R, 7, X1, 0, UL, DECK + 0.03, hU, C.under, {}));
  for (const u of [9, 19, 29]) svg.add(svg.line3(R(7.3, u, hU), R(X1 - 0.3, u, hU), C.underLine, 1, ' stroke-dasharray="6 4"'));
  // rake drip edge OVER the underlayment
  const rd = [[X1 - 2.6, hU + 0.06], [X1 + 0.84, hU + 0.06], [X1 + 0.84, -1.9], [X1 + 1.5, -2.35]];
  svg.add(ribbonF(svg, R, rd, 0.3, UL - 2.5, C.metal, { endAt: 'b1' }));
  // starters: along the eave, and up the rake (over the drip edge)
  const hs = hU + 0.12;
  svg.add(svg.box(R, 12, X1 + 0.5, -0.5, 7, hs, hs + 0.28, C.starter, {}));
  svg.add(svg.box(R, X1 - 7, X1 + 0.5, 7, UL - 9, hs, hs + 0.28, C.starter, {}));
  svg.add(svg.line3(R(X1 - 0.8, 7.3, hs + 0.28), R(X1 - 0.8, UL - 9.3, hs + 0.28), C.sealant, 2.2, ' stroke-dasharray="5 3"'));
  // shingles (two courses, cut back on the left and below the top)
  svg.add(shingleCourses(svg, R, { a0: 17, a1: X1 + 0.5, uStart: -0.5, n: 2, h: hs + 0.28, seed: 5 }));

  svg.top(svg.callout(1, R(3.5, 22, DECK), [220, 300], 'Roof deck', ['Plywood or OSB'], { side: 'left' }));
  svg.top(svg.callout(2, [X1 + 0.75, R(X1, 18, 0)[1], R(X1, 18, 0)[2] - 4.5], [960, 700], 'Rake board', ['The trim along the', 'sloped side edge']));
  svg.top(svg.callout(3, R(14, 26, hU), [220, 470], 'Underlayment FIRST', ['Runs out to the', 'edge of the deck'], { side: 'left' }));
  svg.top(svg.callout(4, R(X1 + 0.84, 25, -0.8), [960, 520], 'Drip edge OVER it', ['At the rake, metal goes on', 'top of the underlayment']));
  svg.top(svg.callout(5, R(X1 - 3, 17, hs + 0.28), [960, 330], 'Starter strip up the rake', ['Set over the drip edge,', 'sealant near the edge']));
  svg.top(svg.callout(6, R(28, 4, hs + 1), [220, 690], 'Shingles', ['Finish flush over', 'the rake starter'], { side: 'left' }));
  return svg.render({
    eyebrow: 'How it’s built · The rake', heading: 'At the rake the order flips.',
    footnote: 'Per GAF Timberline HDZ/UHDZ instructions · KY R905.2.8.5',
  });
}

// #15 — starter strip overhang at the eave/rake corner.
export function starterDetail() {
  const svg = new Svg({
    id: 'start', scale: 19, origin: [150, 560],
    title: 'Starter strip overhang at the roof edge',
    desc: 'A close-up of the corner where the eave meets the rake. The starter strip sits a little past the drip edge, about a quarter to three quarters of an inch, along both the eave and the rake, with its factory sealant strip near the edge. The first course of shingles lines up flush with the starter, so water drips clear of the metal and the sealant holds the bottom edge down in wind.',
  });
  const X1 = 20, UL = 15;
  const { R, s } = corner(svg, { X1, UL });
  svg.add(s);
  const hU = DECK + 0.1;
  svg.add(ribbonX(svg, eaveDrip(R), 0, X1 + 0.9, C.metal, { edge: 2 }));
  svg.add(svg.box(R, 0, X1, 0, UL, DECK + 0.02, hU, C.ice, {}));
  const rd = [[X1 - 2.6, hU + 0.05], [X1 + 0.84, hU + 0.05], [X1 + 0.84, -1.9], [X1 + 1.5, -2.35]];
  svg.add(ribbonF(svg, R, rd, 0.3, UL - 1, C.metal, { endAt: 'b1', edge: 2 }));
  // starter along the eave (cut back on the left) and up the rake
  const hs = hU + 0.1, OV = 0.5;
  svg.add(svg.box(R, 3, X1 + OV, -OV, 7, hs, hs + 0.3, C.starter, {}));
  svg.add(svg.box(R, X1 - 7, X1 + OV, 7, UL - 1.5, hs, hs + 0.3, C.starter, {}));
  svg.add(svg.line3(R(3.4, 1.0, hs + 0.3), R(X1 + 0.1, 1.0, hs + 0.3), C.sealant, 3.2, ' stroke-dasharray="7 4"'));
  svg.add(svg.line3(R(X1 - 0.6, 7.3, hs + 0.3), R(X1 - 0.6, UL - 1.8, hs + 0.3), C.sealant, 3.2, ' stroke-dasharray="7 4"'));
  // first course, flush with the starter, cut back to show it
  svg.add(shingleCourses(svg, R, { a0: 9, a1: X1 + OV, uStart: -OV, n: 1, h: hs + 0.3, t: 0.36, seed: 9 }));

  // inset: section through the eave, drawn flat and enlarged
  svg.top(eaveSectionInset(svg, 745, 175, OV));
  svg.top(svg.callout(1, R(X1 + 0.84, 4, -1.2), [640, 790], 'Drip edge', ['At the eave and up the rake']));
  svg.top(svg.callout(2, R(5, 3.2, hs + 0.3), [300, 790], 'Starter strip', ['A little past the drip edge,', 'eave and rake alike'], { side: 'left' }));
  svg.top(svg.callout(3, R(5.5, 1.0, hs + 0.3), [300, 220], 'Factory sealant row', ['Glues down the first', 'course at the edge'], { side: 'left' }));
  svg.top(svg.callout(4, R(14, 3, hs + 0.8), [600, 200], 'First course', ['Flush with the starter'], { side: 'left' }));
  return svg.render({
    eyebrow: 'How it’s built · The starter', heading: 'A quarter to three quarters of an inch.',
    footnote: 'Overhang per GAF Timberline HDZ/UHDZ instructions (RESTL622)',
  });
}

// A flat, enlarged section through the eave edge (looking along the eave).
function eaveSectionInset(svg, x, y, OV) {
  const k = 44, W = 410, H = 420;
  const ox = x + 95, oy = y + 200;                 // screen origin = deck-top at the eave edge
  const P = (Y, Z) => [ox + Y * k, oy - Z * k];
  const poly = (ps, fill, ex = '') => `<polygon points="${ps.map((p) => P(...p).map((n) => Math.round(n * 10) / 10).join(',')).join(' ')}" fill="${fill}" stroke="${C.ink}" stroke-width="1"${ex}/>`;
  const sl = 0.5, d = 0.6 / Math.cos(Math.atan(sl));
  const top = (Y) => Y * sl;                        // deck top line, through (0, 0)
  let s = `<g class="inset"><rect x="${x}" y="${y}" width="${W}" height="${H}" rx="8" fill="#fbfaf7" stroke="${C.rule}" stroke-width="1.5"/>`;
  s += `<text class="ntb" x="${x + 20}" y="${y + 32}">Section at the eave, enlarged</text>`;
  s += `<clipPath id="start-clip"><rect x="${x + 2}" y="${y + 44}" width="${W - 4}" height="${H - 48}"/></clipPath><g clip-path="url(#start-clip)">`;
  // fascia + deck
  s += poly([[-0.75, -d - 0.2], [0, -d - 0.2], [0, -3.6], [-0.75, -3.6]], '#f4f1ea');
  s += `<path d="M${P(-1.0, -3.6).join(' ')}L${P(0.25, -3.6).join(' ')}" stroke="#fbfaf7" stroke-width="6"/>`;
  s += poly([[-0.75, top(-0.75)], [6, top(6)], [6, top(6) - d], [-0.75, top(-0.75) - d]], C.osb);
  // drip edge (sheet metal drawn with a little thickness)
  const m = [[2.4, top(2.4) + 0.04], [-0.78, top(-0.78) + 0.04], [-0.9, -1.9], [-1.45, -2.3]];
  s += `<polyline points="${m.map((p) => P(...p).join(',')).join(' ')}" fill="none" stroke="${C.metalDark}" stroke-width="5" stroke-linejoin="round"/>`;
  s += `<polyline points="${m.map((p) => P(...p).join(',')).join(' ')}" fill="none" stroke="${C.metal}" stroke-width="2.6" stroke-linejoin="round"/>`;
  // ice barrier, starter, first course
  const L = (Y, off) => [Y, top(Y) + off];
  s += poly([L(-0.8, 0.07), L(6, 0.07), L(6, 0.22), L(-0.8, 0.22)], C.ice);
  const e = -0.95 - OV;                            // edge of the starter / shingle
  s += poly([L(e, 0.22), L(6, 0.22), L(6, 0.5), L(e, 0.5)], C.starter);
  s += `<circle cx="${P(e + 0.55, top(e + 0.55) + 0.36)[0]}" cy="${P(e + 0.55, top(e + 0.55) + 0.36)[1]}" r="4" fill="${C.sealant}"/>`;
  s += poly([L(e, 0.5), L(6, 0.5), L(6, 0.85), L(e, 0.85)], C.shingle);
  // dimension: drip edge face to starter edge
  const yy = -2.75;
  s += `<line x1="${P(-0.95, 0)[0]}" y1="${P(0, top(-0.95) - 0.1)[1]}" x2="${P(-0.95, 0)[0]}" y2="${P(0, yy - 0.3)[1]}" stroke="${C.orange}" stroke-width="1" stroke-dasharray="3 3"/>`;
  s += `<line x1="${P(e, 0)[0]}" y1="${P(0, top(e) + 0.2)[1]}" x2="${P(e, 0)[0]}" y2="${P(0, yy - 0.3)[1]}" stroke="${C.orange}" stroke-width="1" stroke-dasharray="3 3"/>`;
  s += `<line x1="${P(e, 0)[0]}" y1="${P(0, yy)[1]}" x2="${P(-0.95, 0)[0]}" y2="${P(0, yy)[1]}" stroke="${C.orange}" stroke-width="1.6" marker-start="url(#start-ar)" marker-end="url(#start-ar)"/>`;
  s += `<text class="dl" x="${P(e, 0)[0] - 8}" y="${P(0, yy)[1] + 28}" text-anchor="start">¼–¾ in</text>`;
  s += `</g>`;
  s += `<text class="nt" x="${x + 20}" y="${y + H - 44}">Measured past the drip edge. Same rule</text>`;
  s += `<text class="nt" x="${x + 20}" y="${y + H - 24}">up the rake. Water drips clear of the metal.</text>`;
  return s + '</g>';
}
