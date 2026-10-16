// #13 — the nailing area: correct vs high vs low.
import { Svg, C, roofPlane, shingleCourses, r1 } from './lib.mjs';

const H = 13.25, EX = 5.625, NAIL = 6.875;   // GAF Timberline HDZ/UHDZ (RESTL622)

function nailHead(svg, p, ok = true) {
  const q = svg.P(p);
  return `<g><circle cx="${r1(q[0])}" cy="${r1(q[1])}" r="7" fill="${ok ? '#d9dde2' : '#f3d9cd'}" stroke="${C.ink}" stroke-width="1.4"/><circle cx="${r1(q[0])}" cy="${r1(q[1])}" r="2" fill="${C.ink}"/></g>`;
}

export function nailZone() {
  const svg = new Svg({
    id: 'nail', scale: 12.4, origin: [215, 440],
    title: 'Where shingle nails go: the nailing area',
    desc: 'A laminated shingle course with its nailing area marked. On GAF Timberline HDZ and UHDZ shingles the instructions call for 4 nails about 6 and 7/8 inches up from the bottom edge, inside the nailing area, with a 5 and 5/8 inch exposure. Three small sections show why: a nail in the nailing area goes through both layers of the shingle and through the top of the shingle below it; a nail set too high misses the shingle below; a nail set too low ends up in the exposed part of the roof, where the next course does not cover it.',
  });
  const R = roofPlane([0, 0, 0], 2.5);
  const L = 39.375;
  // lower course (whole), then the course being nailed, offset by the exposure
  svg.add(shingleCourses(svg, R, { a0: 0, a1: L, uStart: 0, n: 1, h: 0, t: 0.3, seed: 4 }));
  svg.add(shingleCourses(svg, R, { a0: 0, a1: L, uStart: EX, n: 1, h: 0.3, t: 0.3, seed: 8 }));
  // nailing area band on the upper course (drawn, not dimensioned: it's printed on the shingle)
  const u0 = EX + NAIL - 0.75, u1 = EX + NAIL + 0.75, hh = 0.62;
  svg.add(svg.poly([R(0, u0, hh), R(L, u0, hh), R(L, u1, hh), R(0, u1, hh)], C.orange, { stroke: null, op: 0.22 }));
  svg.add(svg.line3(R(0, u0, hh), R(L, u0, hh), C.orange, 1.4, ' stroke-dasharray="6 4"'));
  svg.add(svg.line3(R(0, u1, hh), R(L, u1, hh), C.orange, 1.4, ' stroke-dasharray="6 4"'));
  // 4 nails, standard pattern
  for (const a of [1.5, 13, L - 13, L - 1.5]) svg.add(nailHead(svg, R(a, EX + NAIL, hh)));
  // dims: exposure and nail height (on the right end)
  svg.top(svg.dim(R(L, EX, 0.6), R(L, EX + NAIL, 0.6), [3.2, 0, 0], '≈ 6⅞ in', { dx: 48, dy: 6 }));
  svg.top(svg.dim(R(L, 0, 0.3), R(L, EX, 0.3), [3.2, 0, 0], '5⅝ in', { dx: 40, dy: 8 }));
  svg.top(svg.callout(1, R(20, EX + NAIL + 0.4, hh), [520, 175], 'The nailing area', ['Printed on the shingle; 4 nails', 'here (6 for the enhanced pattern)'], { side: 'left' }));
  svg.top(svg.callout(2, R(6, 2.5, 0.3), [180, 540], 'Exposure', ['The part you see:', '5⅝ in per course'], { side: 'left' }));
  svg.top(svg.note(820, 180, ['Nail height on GAF Timberline', 'HDZ / UHDZ: about 6⅞ in up', 'from the bottom edge.', 'TAMKO Heritage uses its own', 'line (6⅛ in): always the', 'maker’s wrapper, not habit.']));

  // three sections: correct / high / low
  svg.top(sections(svg, 40, 625));
  return svg.render({
    eyebrow: 'How it’s built · Nailing', heading: 'Four nails. Right in the nailing area.',
    footnote: 'Per GAF Timberline HDZ/UHDZ instructions (RESTL622) · TAMKO Heritage instructions',
  });
}

// Flat sections through three courses (slope drawn level, thickness exaggerated).
function sections(svg, x, y) {
  const k = 12.5, th = 15, W = 360, Hh = 200;
  const cases = [
    { t: 'In the nailing area', s: 'Through both layers and the', s2: 'top of the shingle below', at: NAIL, ok: true },
    { t: 'Too high', s: 'Misses the shingle below:', s2: 'not the maker’s pattern', at: NAIL + 2.3, ok: false },
    { t: 'Too low', s: 'Lands in the exposed part:', s2: 'the next course won’t cover it', at: EX - 1.4, ok: false },
  ];
  let s = '';
  cases.forEach((c, i) => {
    const bx = x + i * (W + 20), by = y;
    s += `<g><rect x="${bx}" y="${by}" width="${W}" height="${Hh}" rx="8" fill="#fbfaf7" stroke="${C.rule}" stroke-width="1.5"/>`;
    s += `<circle cx="${bx + 26}" cy="${by + 28}" r="12" fill="${c.ok ? C.navy : C.orange}"/>`;
    s += c.ok ? `<path d="M${bx + 20} ${by + 28}l4.5 4.5 8-9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M${bx + 21} ${by + 23}l10 10M${bx + 31} ${by + 23}l-10 10" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`;
    s += `<text class="ntb" x="${bx + 48}" y="${by + 34}">${c.t}</text>`;
    // deck line + three courses, eave to the left; course n butt at n*EX
    const X = (u) => bx + 92 + u * k, base = by + 132;
    s += `<rect x="${bx + 10}" y="${base}" width="${W - 20}" height="10" fill="${C.osb}" stroke="${C.ink}" stroke-width="1"/>`;
    const course = (n) => {
      const u0 = -EX + n * EX, lift = n * th;
      const x0 = Math.max(X(u0), bx + 10), x1 = Math.min(X(u0 + H), bx + W - 10);
      return `<path d="M${x0} ${base - lift}L${x1} ${base - lift - 3}L${x1} ${base - lift - 3 - th}L${x0} ${base - lift - th}Z" fill="${n === 1 ? C.shingleLight : C.shingle}" stroke="${C.ink}" stroke-width="1"/>`;
    };
    s += course(0) + course(1);
    // the nail goes into the MIDDLE course (butt at u = 0), then the next course covers it
    const nx = X(c.at), top = base - th - th - 3 * (c.at / H);
    s += `<line x1="${nx}" y1="${top}" x2="${nx}" y2="${base + 12}" stroke="${C.ink}" stroke-width="3"/>`;
    s += `<rect x="${nx - 8}" y="${top - 5}" width="16" height="5" rx="2" fill="${c.ok ? C.navy : C.orange}"/>`;
    s += course(2);
    s += `<text class="nt" x="${bx + 20}" y="${by + 170}">${c.s}</text><text class="nt" x="${bx + 20}" y="${by + 189}">${c.s2}</text>`;
    s += '</g>';
  });
  return s;
}
