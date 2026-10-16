// #8 — ice dams: how they form, and what keeps the water out.
import { Svg, C, r1, shade } from './lib.mjs';
import { H } from './house.mjs';

const d = H.deck, top = (x) => d(x) + 2.6, OH = H.OH;

function eave(svg, warm) {
  const D = 30, S = (x, z, y = 0) => [x, y, z];
  const X2 = 70;
  let s = '';
  // back faces: roof surface receding, side wall
  s += svg.poly([S(-OH, top(-OH)), S(X2, top(X2)), S(X2, top(X2), D), S(-OH, top(-OH), D)], shade(C.shingle, [-0.45, 0, 0.9]), {});
  for (let x = -OH + 5; x < X2; x += 5) s += svg.line3(S(x, top(x)), S(x, top(x), D), C.shingleShadow, 0.7);
  // section (front face y = 0)
  const zs = d(-OH) - 6;
  s += svg.poly([S(0, H.WALL - 16), S(X2, H.WALL - 16), S(X2, H.WALL), S(0, H.WALL)], warm ? '#fbe6da' : '#f6f4ef', { sw: 1 });
  s += svg.poly([S(0, H.WALL), S(X2, H.WALL), S(X2, d(X2) - H.RAFT), S(-OH, d(-OH) - H.RAFT)], warm ? '#f8e3d6' : '#eaf1f7', { sw: 1 });
  s += svg.poly([S(0, H.WALL - 16), S(5.5, H.WALL - 16), S(5.5, H.WALL), S(0, H.WALL)], C.woodDark, { sw: 1 });
  s += svg.poly([S(0, H.WALL - 1), S(X2, H.WALL - 1), S(X2, H.WALL + 1.5), S(0, H.WALL + 1.5)], C.drywall, { sw: 0.8 });
  s += svg.poly([S(-OH, zs), S(0, zs), S(0, zs + 1.2), S(-OH, zs + 1.2)], '#f4f1ea', { sw: 0.9 });
  s += svg.poly([S(-OH - 0.8, zs), S(-OH, zs), S(-OH, top(-OH)), S(-OH - 0.8, top(-OH))], '#f4f1ea', { sw: 0.9 });
  // insulation: thin + gappy (warm) vs full depth with baffle (cold)
  const ins = warm ? 4 : 13;
  const insTop = (x) => Math.min(H.WALL + 1.5 + ins, d(x) - H.RAFT - (warm ? 0.5 : 2.2));
  const xs = []; for (let x = 5.5; x <= X2; x += 4) xs.push(x);
  s += svg.poly([S(5.5, H.WALL + 1.5), ...xs.map((x) => S(x, insTop(x))), S(X2, H.WALL + 1.5)], C.insul, { stroke: C.insulDark, sw: 1 });
  // rafter, deck, roof layers in section
  const seg = []; for (let i = 0; i <= 14; i++) seg.push(-OH + (X2 + OH) * (i / 14));
  s += svg.poly([...seg.map((x) => S(x, d(x) - H.RAFT)), ...seg.slice().reverse().map((x) => S(x, d(x)))], C.wood, { sw: 0.8 });
  s += svg.poly([...seg.map((x) => S(x, d(x))), ...seg.slice().reverse().map((x) => S(x, d(x) + 1.2))], C.osb, { sw: 0.8 });
  s += svg.poly([...seg.map((x) => S(x, d(x) + 1.2)), ...seg.slice().reverse().map((x) => S(x, top(x)))], C.shingle, { sw: 0.8 });
  // the wall line (exterior face) projected up to the deck
  s += svg.line3(S(0, H.WALL - 16), S(0, d(0) + 1.2), C.orange, 1.2, ' stroke-dasharray="6 4"');
  return { s, S, X2, zs };
}

function snowLayer(svg, S, from, to, thick) {
  const xs = []; for (let x = from; x <= to + 0.01; x += 3) xs.push(x);
  const D = 30;
  const topS = xs.map((x) => S(x, top(x) + thick(x)));
  return svg.poly([...topS, ...xs.slice().reverse().map((x) => S(x, top(x) + thick(x), D))], '#f4f8fb', { stroke: C.snowEdge, sw: 1 }) + svg.poly([...xs.map((x) => S(x, top(x))), ...xs.slice().reverse().map((x) => S(x, top(x) + thick(x)))], C.snow, { stroke: C.snowEdge, sw: 1.2 });
}

function panel(svg, warm) {
  const { s: base, S, X2, zs } = eave(svg, warm);
  let s = base;
  if (warm) {
    // ice dam at the cold overhang, water ponding behind it, snow melting above
    s += snowLayer(svg, S, 28, X2, (x) => 4 + (x - 28) * 0.1);
    const dam = [S(-OH, top(-OH)), S(-OH + 4, top(-OH) + 7), S(2, top(2) + 8), S(10, top(10) + 4), S(16, top(16) + 0.2)];
    const pond = [S(8, top(8)), S(30, top(30)), S(30, top(30) + 2.4), S(14, top(14) + 3.8), S(8, top(8) + 3.2)];
    s += svg.poly(pond, C.water, { stroke: '#2b6fa8', sw: 1, op: 0.85 });
    s += svg.poly([dam[0], dam[1], dam[1].map((v, k) => (k === 1 ? 30 : v)), dam[0].map((v, k) => (k === 1 ? 30 : v))], '#c4e1f3', { stroke: C.iceEdge, sw: 1 });
    s += svg.poly([dam[1], dam[2], dam[2].map((v, k) => (k === 1 ? 30 : v)), dam[1].map((v, k) => (k === 1 ? 30 : v))], '#cfe7f6', { stroke: C.iceEdge, sw: 1 });
    s += svg.poly(dam, C.iceBlue, { stroke: C.iceEdge, sw: 1.4 });
    for (const dz of [0, 3.2, 6]) s += svg.poly([S(-OH - 0.4 + dz * 0.1, zs + 1), S(-OH + 0.9 + dz * 0.1, zs + 1), S(-OH + 0.25 + dz * 0.1, zs - 7 - dz)], C.iceBlue, { stroke: C.iceEdge, sw: 1 });
    // water backing up under the shingles
    s += svg.path3([S(22, top(22) - 0.6), S(6, d(6) + 1.3), S(-2, d(-2) + 1.3)].reverse(), C.water, 2.6, ` marker-end="url(#${svg.id}-wa)"`);
    // heat rising from the house
    for (const x of [24, 46]) s += svg.path3([S(x, H.WALL + 6), S(x + 4, H.WALL + 14), S(x - 2, H.WALL + 22), S(x + 3, d(x) - H.RAFT - 3)], C.airWarm, 2.4, ` marker-end="url(#${svg.id}-ha)" stroke-dasharray="1 0"`);
    // drips inside the wall
    for (const z of [H.WALL - 5, H.WALL - 11]) s += `<circle cx="${r1(svg.P(S(3, z))[0])}" cy="${r1(svg.P(S(3, z))[1])}" r="3.2" fill="${C.water}"/>`;
  } else {
    s += snowLayer(svg, S, -OH, X2, () => 6);
    // ice & water shield from the eave to 24 in+ past the wall line (under the shingles)
    const uW = (0 + OH) / Math.cos(H.T), end = -OH + (uW + 24 + 1.5) * Math.cos(H.T);
    s += svg.path3([S(-OH, d(-OH) + 1.5), S(end, d(end) + 1.5)], C.ice, 4);
    s += svg.dim(S(0, d(0) + 1.6), S(end, d(end) + 1.6), [0, 0, 12], '24 in+', { dy: -6 });
    // cold intake air along the underside of the deck
    s += svg.path3([S(-10, zs - 8), S(-8, zs - 1), S(-2, d(-2) - H.RAFT - 1.1), S(60, d(60) - H.RAFT - 1.1)], C.air, 3, ` stroke-dasharray="9 7" marker-end="url(#${svg.id}-ca)"`);
  }
  return s;
}

export function iceDam() {
  const svg = new Svg({
    id: 'ice', scale: 5.0, origin: [150, 1010],
    title: 'How an ice dam forms, and what keeps the water out',
    desc: 'Two cut-away views of a roof eave in winter. Left: heat leaking up from the house warms the roof deck, snow on the warm part of the roof melts, and the water refreezes on the cold overhang into a ridge of ice. Meltwater pools behind the ice dam and backs up under the shingles, where it can drip into the wall and ceiling. Right: a well-insulated and air-sealed attic floor and soffit-to-ridge ventilation keep the deck closer to outdoor temperature, so snow melts more evenly; ice and water shield under the shingles from the eave to at least 24 inches past the inside of the exterior wall line seals out water that does back up. Ice and water shield does not stop ice dams; it is the backup that keeps their water out.',
  });
  svg.def(`<marker id="${svg.id}-wa" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M1 1L9 5L1 9z" fill="${C.water}"/></marker>`);
  svg.def(`<marker id="${svg.id}-ha" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M1 1L9 5L1 9z" fill="${C.airWarm}"/></marker>`);
  svg.def(`<marker id="${svg.id}-ca" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M1 1L9 5L1 9z" fill="${C.air}"/></marker>`);
  const DX = 560;
  svg.add(`<g>${panel(svg, true)}</g><g transform="translate(${DX} 0)">${panel(svg, false)}</g>`);
  svg.top(`<text class="ntb" x="60" y="150">HOW AN ICE DAM FORMS</text><text class="ntb" x="${60 + DX}" y="150">WHAT KEEPS THE WATER OUT</text>`);
  const at = (dx, p) => { const q = svg.P(p); return [q[0] + dx, q[1]]; };
  svg.top(svg.callout(1, at(0, [60, 0, H.WALL + 16]), [70, 220], 'Heat leaks into the attic', ['and warms the roof deck']));
  svg.top(svg.callout(2, at(0, [50, 0, top(50) + 6]), [330, 290], 'Snow melts up high', ['and runs down the roof']));
  svg.top(svg.callout(3, at(0, [-8, 0, top(-8) + 5]), [70, 790], 'Refreezes on the cold eave', ['into a ridge of ice']));
  svg.top(svg.callout(4, at(0, [12, 0, top(12) + 1.5]), [330, 730], 'Water backs up', ['under the shingles']));
  svg.top(svg.callout(5, at(DX, [40, 0, H.WALL + 9]), [70 + DX, 780], 'Insulated, air-sealed floor', ['keeps house heat down']));
  svg.top(svg.callout(6, at(DX, [36, 0, d(36) - H.RAFT - 1.1]), [70 + DX, 220], 'Soffit-to-ridge airflow', ['keeps the deck cold']));
  svg.top(svg.callout(7, at(DX, [16, 0, d(16) + 1.5]), [330 + DX, 290], 'Ice & water shield', ['The backup: 24 in+ past', 'the wall line']));
  return svg.render({
    eyebrow: 'How it works · Ice dams', heading: 'Ice dams start in the attic.',
    footnote: 'OH & KY R905.1.2 (ice barrier) · R806 (ventilation)',
  });
}
