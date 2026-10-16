// #6 — attic ventilation: soffit intake, baffles, ridge exhaust. Also the
// inline SVG for the animated airflow component (docs/assets/js/vent-flow.js).
import { Svg, C, esc, r1 } from './lib.mjs';
import { H, houseShell, houseSection } from './house.mjs';

function airPaths(svg) {
  const { W, OH } = H, d = H.deck;
  const S = (x, z) => [x, -0.5, z];
  const zs = d(-OH) - 6;
  const side = (k) => { // k = 1 front, -1 back (mirror about the ridge)
    const m = (y) => (k === 1 ? y : W - y);
    const intake = [S(m(-12), zs - 16), S(m(-10), zs - 3), S(m(-4), d(-4) - H.RAFT - 1.2), S(m(40), d(40) - H.RAFT - 1.2)];
    const exhaust = [S(m(40), d(40) - H.RAFT - 1.2), S(m(100), d(100) - H.RAFT - 4), S(m(W / 2 - 8), d(W / 2 - 8) - H.RAFT - 1), S(W / 2, d(W / 2) + 3), S(m(W / 2 - 4), d(W / 2) + 22)];
    return { intake, exhaust };
  };
  const toD = (ps) => 'M' + ps.map((p) => svg.P(p)).map((q) => r1(q[0]) + ' ' + r1(q[1])).join('L');
  let s = '';
  for (const k of [1, -1]) {
    const { intake, exhaust } = side(k);
    s += `<path class="vf vf-in" d="${toD(intake)}" fill="none" stroke="${C.air}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="10 9" marker-end="url(#${svg.id}-ai)"/>`;
    s += `<path class="vf vf-out" d="${toD(exhaust)}" fill="none" stroke="${C.airWarm}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="10 9" marker-end="url(#${svg.id}-ao)"/>`;
  }
  return s;
}

function build(inline) {
  const svg = new Svg({
    id: inline ? 'vx' : 'vent', scale: 1.8, origin: inline ? [50, 420] : [200, 640], w: inline ? 760 : 1200, h: inline ? 560 : 900,
    title: 'How attic ventilation moves air from the soffits to the ridge',
    desc: 'A house cut in half to show the attic. Cool outside air comes in through vents in the soffits under the roof overhang, travels up through baffles that hold the insulation back from the roof deck, crosses the attic under the deck, and leaves through the ridge vent at the peak. The code minimum is 1 square foot of net free vent area for every 150 square feet of attic floor, or 1 for every 300 when 40 to 50 percent of it is high exhaust within 3 feet of the ridge and the rest is low intake.',
  });
  svg.def(`<marker id="${svg.id}-ai" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto"><path d="M1 1L9 5L1 9z" fill="${C.air}"/></marker>`);
  svg.def(`<marker id="${svg.id}-ao" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto"><path d="M1 1L9 5L1 9z" fill="${C.airWarm}"/></marker>`);
  svg.add(houseShell(svg, { D: 150 }));
  svg.add(houseSection(svg, {}));
  svg.add(`<g class="vf-group">${airPaths(svg)}</g>`);
  if (inline) {
    // numbered tags matching the key under the figure
    const d0 = H.deck, OH0 = H.OH;
    const pts = [[-12, 0, d0(-OH0) - 14], [26, 0, d0(26) - H.RAFT - 9], [70, 0, H.WALL + 9], [H.W / 2 + 14, 0, d0(H.W / 2) + 16], [210, 0, d0(210) - 18]];
    svg.add(pts.map((p, i) => { const q = svg.P(p); return `<g class="nb" aria-hidden="true"><circle cx="${r1(q[0])}" cy="${r1(q[1])}" r="15"/><text x="${r1(q[0])}" y="${r1(q[1] + 6)}" text-anchor="middle">${i + 1}</text></g>`; }).join(''));
    return svg;
  }
  const { W, OH } = H, d = H.deck;
  svg.top(svg.callout(1, [-8, 0, d(-OH) - 6.4], [120, 760], 'Soffit vents: intake', ['Fresh air in, low']));
  svg.top(svg.callout(2, [24, 0, d(24) - H.RAFT - 2], [120, 320], 'Baffles', ['Hold insulation back so', 'air can get past it']));
  svg.top(svg.callout(3, [70, 0, H.WALL + 9], [330, 700], 'Insulation on the floor', ['Keeps house heat out', 'of the attic']));
  svg.top(svg.callout(4, [W / 2, 0, d(W / 2) + 6], [120, 200], 'Ridge vent: exhaust', ['Warm, damp air out, high']));
  svg.top(svg.callout(5, [210, 0, d(210) - 14], [930, 560], 'Air sweeps the deck', ['Dries it out and', 'keeps it cooler']));
  // the rule
  const bx = 830, by = 130;
  svg.top(`<g><rect x="${bx}" y="${by}" width="340" height="230" rx="8" fill="#fbfaf7" stroke="${C.rule}" stroke-width="1.5"/>`
    + `<text class="ntb" x="${bx + 20}" y="${by + 34}">The code minimum (OH &amp; KY R806.2)</text>`
    + svg.note(bx + 20, by + 62, ['1 sq ft of net free vent area for', 'every 150 sq ft of attic floor, or', '1 per 300 when 40–50% of it is high', 'exhaust (within 3 ft of the ridge)', 'and the rest is low intake.'])
    + `<text class="ntb" x="${bx + 20}" y="${by + 172}">Example: 1,500 sq ft attic</text>`
    + svg.note(bx + 20, by + 198, ['÷ 300 = 5 sq ft (720 sq in) total:', '2–2.5 sq ft high, the rest low.'])
    + `</g>`);
  return svg;
}

export function ventilation() {
  return build(false).render({
    eyebrow: 'How it works · Attic ventilation', heading: 'In low at the soffits. Out high at the ridge.',
    footnote: 'OH & KY R806.2 & R806.3 · GAF: ventilation must meet or exceed code',
  });
}

export function ventilationInline() {
  const svg = build(true);
  return [
    `<svg class="vx-svg" viewBox="0 0 ${svg.w} ${svg.h}" width="${svg.w}" height="${svg.h}" role="img" aria-labelledby="vx-t vx-d" focusable="false">`,
    `<title id="vx-t">${esc(svg.title)}</title><desc id="vx-d">${esc(svg.desc)}</desc>`,
    `<defs>${svg.defs.join('')}</defs>`,
    ...svg.parts, `</svg>`,
  ].join('');
}
