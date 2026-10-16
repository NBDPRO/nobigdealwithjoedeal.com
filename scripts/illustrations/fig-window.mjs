// #10 — window flashing sequence, shingle-fashion (generic; the window
// maker's instructions govern).
import { Svg, C, r1 } from './lib.mjs';

const W = 40, Hh = 46, X0 = 11, X1 = 29, Z0 = 12, Z1 = 36, y = 0;
const q = (x0, z0, x1, z1, yy = y) => [[x0, yy, z0], [x1, yy, z0], [x1, yy, z1], [x0, yy, z1]];

function panel(svg, step) {
  let s = '';
  s += svg.poly(q(0, 0, W, Hh), C.sheath, {});
  // housewrap with the opening cut (modified I-cut) and the head flap
  s += svg.poly(q(0, 0, W, Hh, -0.1), '#eef2f6', {});
  for (const z of [8, 20, 32, 42]) s += svg.line3([1, -0.12, z], [W - 1, -0.12, z], C.wrapLine, 0.9, ' stroke-dasharray="2 6"');
  s += svg.poly(q(X0, Z0, X1, Z1, -0.12), '#3b3f45', {});
  const flapUp = step < 4;
  const tape = (pts, extra = {}) => svg.poly(pts, C.tape, { sw: 1, ...extra });
  // 1: sill tape across the sill, turned 6 in up each jamb
  const sill = [[X0 - 2.5, -0.2, Z0 - 2.5], [X1 + 2.5, -0.2, Z0 - 2.5], [X1 + 2.5, -0.2, Z0 + 6], [X1, -0.2, Z0 + 6], [X1, -0.2, Z0], [X0, -0.2, Z0], [X0, -0.2, Z0 + 6], [X0 - 2.5, -0.2, Z0 + 6]];
  s += tape(sill);
  if (step >= 2) {
    // window: nailing flange + frame + glass
    s += svg.poly(q(X0 - 1.4, Z0 - 0.4, X1 + 1.4, Z1 + 1.4, -0.3), '#e7e3da', {});
    s += svg.poly(q(X0 + 0.6, Z0 + 0.6, X1 - 0.6, Z1 - 0.6, -0.5), '#ffffff', { sw: 1.2 });
    s += svg.poly(q(X0 + 2, Z0 + 2, X1 - 2, Z1 - 2, -0.55), '#a9bccf', {});
    s += svg.line3([(X0 + X1) / 2, -0.6, Z0 + 2], [(X0 + X1) / 2, -0.6, Z1 - 2], '#fff', 2);
    // jamb tapes over the side flanges, past the sill tape and above the head
    s += tape(q(X0 - 3.6, Z0 - 3.5, X0 - 0.6, Z1 + 3.5, -0.65));
    s += tape(q(X1 + 0.6, Z0 - 3.5, X1 + 3.6, Z1 + 3.5, -0.65));
  }
  if (step >= 3 && !flapUp) s += tape(q(X0 - 5, Z1 + 0.4, X1 + 5, Z1 + 4, -0.75), { stroke: C.orange, sw: 2 });
  // head flap: folded up (steps 1-3) or down over the head tape (step 4)
  if (flapUp) {
    s += svg.poly([[X0, -0.15, Z1], [X1, -0.15, Z1], [X1 + 6, -0.15, Z1 + 7], [X0 - 6, -0.15, Z1 + 7]], C.sheath, { sw: 0.8 });
    if (step >= 3) s += tape(q(X0 - 5, Z1 + 0.4, X1 + 5, Z1 + 4, -0.75), { stroke: C.orange, sw: 2 });
    s += svg.poly([[X0 - 6, -1.2, Z1 + 7], [X1 + 6, -1.2, Z1 + 7], [X1 + 1, -1.2, Z1 + 13], [X0 - 1, -1.2, Z1 + 13]], '#f7f9fb', { sw: 1, extra: ' stroke-dasharray="4 3"' });
  }
  else {
    s += svg.poly([[X0 - 6, -0.85, Z1 + 7], [X1 + 6, -0.85, Z1 + 7], [X1, -0.85, Z1], [X0, -0.85, Z1]], '#eef2f6', { sw: 1 });
    s += tape([[X0 - 6.6, -0.9, Z1 + 7.6], [X0 - 5.2, -0.9, Z1 + 7.6], [X0 + 0.6, -0.9, Z1 + 0.6], [X0 - 0.8, -0.9, Z1 + 0.6]]);
    s += tape([[X1 + 5.2, -0.9, Z1 + 7.6], [X1 + 6.6, -0.9, Z1 + 7.6], [X1 + 0.8, -0.9, Z1 + 0.6], [X1 - 0.6, -0.9, Z1 + 0.6]]);
  }
  return s;
}

export function windowFlashing() {
  const svg = new Svg({
    id: 'win', scale: 5.6, origin: [50, 470],
    title: 'Window flashing, in order',
    desc: 'Four steps to flash a window in a housewrapped wall, so every piece laps the one below it like shingles. 1: flashing tape across the sill, turned up the sides. 2: the window goes in and tape covers each side flange, running past the sill tape and above the head. 3: tape across the head flange, over the side tapes. 4: the housewrap flap above the window folds back down over the head tape and its cut corners are taped. Exact steps follow the window maker’s instructions; this is the common sequence.',
  });
  const DX = 285;
  for (let i = 1; i <= 4; i++) svg.add(`<g transform="translate(${(i - 1) * DX} 0)">${panel(svg, i)}</g>`);
  const caps = [
    ['Sill first', 'Tape across the sill,', 'turned up each side'],
    ['Window in, then sides', 'Side tapes run past the', 'sill tape and above the head'],
    ['Then the head', 'Head tape laps over', 'both side tapes'],
    ['Wrap flap down', 'Housewrap folds over the', 'head tape; corners taped'],
  ];
  caps.forEach(([t, a, b], i) => {
    const x = 70 + i * DX;
    svg.top(`<g class="nb"><circle cx="${x}" cy="610" r="17"/><text x="${x}" y="616.5" text-anchor="middle">${i + 1}</text></g>`);
    svg.top(`<text class="lbl" x="${x + 28}" y="617">${t}</text>`);
    svg.top(svg.note(x - 17, 652, [a, b]));
  });
  // arrows between panels
  for (let i = 1; i < 4; i++) { const x = i * DX + 18; svg.top(`<path d="M${x} 360h22" stroke="${C.orange}" stroke-width="3" marker-end="url(#win-ar)"/>`); }
  svg.top(svg.note(40, 750, ['Every piece laps the one below it, like shingles, so water that gets behind the siding runs out, not in.']));
  void r1;
  return svg.render({
    eyebrow: 'How it’s built · Windows', heading: 'Bottom up: sill, sides, head.',
    footnote: 'Generic sequence · OH & KY R703.4 (window maker’s instructions govern)',
  });
}
