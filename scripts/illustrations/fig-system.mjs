// #1 — the whole roof system, exploded. Also builds the inline SVG used by
// the "Pull the roof apart" component (docs/assets/js/roof-explode.js).
import { Svg, C, roofPlane, extrudeX, ribbonX, shingleCourses, flakes, hatchDef, esc, r1 } from './lib.mjs';

const PITCH = 6;
const T = Math.atan(PITCH / 12), TAN = Math.tan(T), COS = Math.cos(T), SIN = Math.sin(T);
const X1 = 96, ULEN = 84, DECK = 0.7;
const GAP = 6;                    // explode lift per layer, inches (world z)
const SCALE = 4.0;

// The layers, bottom to top. `key` is what the page's legend and JS use.
export const LAYERS = [
  { key: 'deck', name: 'Roof deck', short: 'Plywood or OSB over the rafters', text: 'The wood the whole roof is nailed to. I walk it during tear-off and replace any soft or rotted boards before anything goes on top.' },
  { key: 'drip-eave', name: 'Drip edge at the eave', short: 'Metal, nailed to the deck first', text: 'A bent metal edge along the bottom of the roof. At the eave it goes on first, right on the deck, so the ice barrier can lap over it and water drips clear of the fascia.' },
  { key: 'ice', name: 'Ice & water shield', short: 'Self-sealing membrane at the eave', text: 'A sticky, rubbery membrane that seals around nails. It runs up from the eave to at least 24 inches past the inside of the exterior wall, where ice dams back water up.' },
  { key: 'under', name: 'Synthetic underlayment', short: 'Covers the rest of the deck', text: 'A tough synthetic sheet over the rest of the deck, lapped over the ice barrier like shingles so any water that gets under the shingles still runs down and out.' },
  { key: 'drip-rake', name: 'Drip edge at the rake', short: 'Goes OVER the underlayment', text: 'Along the sloped side edges (the rakes) the order flips: underlayment first, then the drip edge on top of it, so water running down the edge can’t get behind the metal.' },
  { key: 'starter', name: 'Starter strip', short: 'Sealant row along the edge', text: 'A strip with a factory sealant line, set just past the edge. It seals down the first course of shingles so wind can’t catch the bottom edge.' },
  { key: 'shingles', name: 'Shingles', short: 'Nailed in the maker’s nailing area', text: 'The weather surface. Each shingle gets its nails in the manufacturer’s nailing area, and each course overlaps the one below it.' },
  { key: 'vent', name: 'Ridge vent', short: 'Hot attic air out at the peak', text: 'A vent over a slot cut along the peak. Warm, wet attic air leaves here while fresh air comes in at the soffits.' },
  { key: 'cap', name: 'Hip & ridge cap', short: 'Covers the vent and the peak', text: 'Thick cap shingles folded over the peak, covering the ridge vent and sealing the very top of the roof.' },
];

function build(mode) {
  const inline = mode === 'inline';
  const svg = new Svg({
    id: inline ? 'rx' : 'sys', scale: SCALE, origin: inline ? [22, 530] : [330, 610], w: inline ? 610 : 1200, h: inline ? 715 : 900,
    title: 'A complete roof system, pulled apart layer by layer',
    desc: 'An exploded view of a shingle roof, bottom to top: the roof deck; metal drip edge along the eave; ice and water shield along the eave, lapping over that drip edge; synthetic underlayment over the rest of the deck; drip edge along the rake, on top of the underlayment; a starter strip at the eave; laminated shingles; a ridge vent over a slot at the peak; and ridge cap shingles over the vent.',
  });
  const R = roofPlane([0, -0.75, -0.75 * TAN], PITCH);
  const woodCut = hatchDef(svg, 'wood', C.woodDark, C.wood, 6);
  const lift = (i) => r1(-i * GAP * SCALE);
  const groups = [];
  const open = (i) => `<g class="rx-layer" data-layer="${LAYERS[i].key}" data-i="${i}" transform="translate(0 ${lift(i)})">`;

  // ridge geometry
  const ridgeU = ULEN;
  const back = (a, v, h) => { // point on the back slope, v down from the ridge
    const r = R(a, ridgeU, 0);
    return [a, r[1] + v * COS + h * SIN * 0, r[2] - v * SIN + h * COS];
  };

  // 0 deck (+ rafter at the cut, fascia, the back slope's edge)
  {
    let s = open(0);
    const dz = 5.5 / COS;
    s += extrudeX(svg, [[0, -dz], [ULEN * COS, ULEN * COS * TAN - dz], [ULEN * COS, ULEN * COS * TAN], [0, 0]], X1 - 1.5, X1, C.wood, { cap: woodCut });
    s += extrudeX(svg, [[-0.75, -6.9], [0, -6.9], [0, -0.1], [-0.75, -0.1]], 0, X1, '#f4f1ea', { cap: woodCut });
    // back slope sliver beyond the ridge
    s += svg.poly([back(0, 0, DECK), back(X1, 0, DECK), back(X1, 14, DECK), back(0, 14, DECK)], C.osb, {});
    s += svg.box(R, 0, X1, 0, ULEN, 0, DECK, C.osb, { faces: { a1: woodCut } });
    s += flakes(svg, R, 1, X1 - 1, 1, ULEN - 3, DECK, 520);
    // ridge vent slot
    s += svg.poly([R(6, ULEN - 1.6, DECK + 0.01), R(X1 - 6, ULEN - 1.6, DECK + 0.01), R(X1 - 6, ULEN, DECK + 0.01), R(6, ULEN, DECK + 0.01)], '#2a2622', { stroke: null });
    groups.push(s + '</g>');
  }
  // 1 drip edge at the eave
  {
    const ztop = R(0, 0, DECK)[2], fl = R(0, 2.5, DECK);
    const drip = [[fl[1], fl[2] + 0.1], [-0.83, ztop + 0.1], [-1.0, ztop - 1.9], [-1.65, ztop - 2.35]];
    groups.push(open(1) + ribbonX(svg, drip, 0, X1, C.metal) + '</g>');
  }
  // 2 ice & water shield (eave to 36 in up the slope)
  {
    let s = open(2) + svg.box(R, 0, X1 - 8, 0, 36, DECK + 0.12, DECK + 0.4, C.ice, {});
    for (let u = 4; u < 36; u += 4) s += svg.line3(R(0.5, u, DECK + 0.4), R(X1 - 8.5, u, DECK + 0.4), C.iceGrain, 0.8, ' opacity=".6"');
    groups.push(s + '</g>');
  }
  // 3 synthetic underlayment
  {
    let s = open(3) + svg.box(R, 0, X1 - 16, 30, ULEN - 1.6, DECK + 0.4, DECK + 0.55, C.under, {});
    for (const u of [34, 44, 54, 64, 74]) s += svg.line3(R(0.5, u, DECK + 0.55), R(X1 - 16.5, u, DECK + 0.55), C.underLine, 1, ' stroke-dasharray="7 5"');
    s += svg.line3(R(0.5, 66, DECK + 0.55), R(X1 - 16.5, 66, DECK + 0.55), C.underLine, 1.2);
    groups.push(s + '</g>');
  }
  // 4 drip edge at the rake (left edge; on top of the underlayment)
  {
    let s = open(4) + svg.box(R, -0.4, 1.8, 0, ULEN - 1, DECK + 0.6, DECK + 0.75, C.metal, {});
    s += svg.box(R, -0.4, 0.2, 0, ULEN - 1, DECK - 1.6, DECK + 0.75, C.metalDark, {});
    groups.push(s + '</g>');
  }
  // 5 starter strip
  {
    let s = open(5) + svg.box(R, 5, X1 - 24, -0.5, 7, DECK + 0.6, DECK + 0.9, C.starter, {});
    s += svg.line3(R(5.5, 1.3, DECK + 0.9), R(X1 - 24.5, 1.3, DECK + 0.9), C.sealant, 2.2, ' stroke-dasharray="6 3"');
    groups.push(s + '</g>');
  }
  // 6 shingles: up to a cut line short of the ridge so the underlayment shows
  {
    const s = open(6) + shingleCourses(svg, R, { a0: 9, a1: X1 - 32, uStart: -0.5, n: 12, h: DECK + 0.9, t: 0.38, seed: 11 });
    groups.push(s + '</g>');
  }
  // 7 ridge vent (straddles the ridge)
  {
    const h = DECK + 1.2, w = 6;
    let s = open(7);
    const f = [R(4, ULEN - w, h), R(X1 - 4, ULEN - w, h), R(X1 - 4, ULEN, h + 0.9), R(4, ULEN, h + 0.9)];
    const b = [R(4, ULEN, h + 0.9), R(X1 - 4, ULEN, h + 0.9), back(X1 - 4, w, h + 0.9 - 0.9), back(4, w, h)];
    s += svg.poly(b, '#3a4048', {});
    s += svg.poly(f, C.vent, {});
    s += svg.poly([R(X1 - 4, ULEN - w, h - 0.8), R(X1 - 4, ULEN - w, h), R(X1 - 4, ULEN, h + 0.9), R(X1 - 4, ULEN, h)], '#1d2126', {});
    for (let a = 8; a < X1 - 6; a += 3) s += svg.line3(R(a, ULEN - w + 0.6, h + 0.08), R(a, ULEN - 0.6, h + 0.82), '#5a626d', 0.9);
    groups.push(s + '</g>');
  }
  // 8 ridge cap: overlapping cap pieces, cut short to show the vent
  {
    const h = DECK + 2.4, w = 6.2;
    let s = open(8);
    for (let a = 4; a < X1 - 44; a += 6.5) {
      const a2 = a + 8.5;
      s += svg.poly([R(a, ULEN, h + 1), R(a2, ULEN, h + 1), back(a2, w, h - 0.5), back(a, w, h - 0.5)], '#3b414a', {});
      s += svg.poly([R(a, ULEN - w, h), R(a2, ULEN - w, h), R(a2, ULEN, h + 1), R(a, ULEN, h + 1)], C.ridge, {});
      s += svg.poly([R(a, ULEN - w, h - 0.4), R(a, ULEN - w, h), R(a, ULEN, h + 1), R(a, ULEN, h + 0.6)], C.shingleShadow, {});
    }
    groups.push(s + '</g>');
  }
  svg.add(groups.join(''));

  // callout anchors (world point on each layer, before lift)
  const anchors = [
    R(X1 - 4, 40, DECK), [X1 - 6, -0.95, R(0, 0, DECK)[2] - 1.0], R(X1 - 12, 18, DECK + 0.4), R(X1 - 20, 46, DECK + 0.55),
    R(0.7, 34, DECK + 0.75), R(X1 - 28, 3.5, DECK + 0.9), R(X1 - 44, 30, DECK + 1.3), R(X1 - 10, ULEN - 3, DECK + 1.5), R(30, ULEN - 2, DECK + 3),
  ];
  const at = (i) => { const p = svg.P(anchors[i]); return [p[0], p[1] + lift(i)]; };
  if (inline) {
    // number tags drawn on top of every layer; each moves with its layer
    // (same data-i / transform), so a higher layer never hides a lower tag
    const tags = LAYERS.map((L, i) => {
      const p = svg.P(anchors[i]);
      return `<g class="rx-tag" data-layer="${L.key}" data-i="${i}" transform="translate(0 ${lift(i)})"><g class="nb" aria-hidden="true"><circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="15"/><text x="${r1(p[0])}" y="${r1(p[1] + 6)}" text-anchor="middle">${i + 1}</text></g></g>`;
    });
    svg.add(`<g class="rx-tags">${tags.join('')}</g>`);
    return svg;
  }
  const side = [[930, 770, 'r'], [270, 760, 'l'], [930, 640, 'r'], [930, 520, 'r'], [270, 470, 'l'], [930, 400, 'r'], [270, 300, 'l'], [930, 270, 'r'], [930, 150, 'r']];
  LAYERS.forEach((L, i) => {
    const [x, y, sd] = side[i];
    svg.top(svg.callout(i + 1, at(i), [x, y], L.name, L.short, { side: sd === 'r' ? 'right' : 'left' }));
  });
  return svg;
}

export function systemExploded() {
  return build('static').render({
    eyebrow: 'How it’s built · The whole system', heading: 'A roof is nine parts, not one.',
    footnote: 'Order per GAF Timberline HDZ/UHDZ instructions · OH & KY residential code R905',
  });
}

// Inline markup for the interactive component (no <style>: page CSS styles it).
export function systemInline() {
  const svg = build('inline');
  return [
    `<svg class="rx-svg" viewBox="0 0 ${svg.w} ${svg.h}" width="${svg.w}" height="${svg.h}" role="img" aria-labelledby="rx-t rx-d" focusable="false" data-rx-lift="${GAP * SCALE}">`,
    `<title id="rx-t">${esc(svg.title)}</title><desc id="rx-d">${esc(svg.desc)}</desc>`,
    `<defs>${svg.defs.join('')}</defs>`,
    ...svg.parts, `</svg>`,
  ].join('');
}
