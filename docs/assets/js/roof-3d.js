/**
 * roof-3d.js — the spinnable 3D gable roof on /services/roof-replacement
 * (Jo, 2026-10-02: "make it look like a real roof, gable style", every code
 * item in it, "go 3D").
 *
 * Progressive enhancement over the static diagram (assets/images/roof-layers.svg,
 * which stays the no-JS / screen-reader / reduced-data version, and whose
 * numbered legend is the real content). Nothing loads until the visitor taps
 * "See it in 3D": then this module pulls in the trimmed Three.js bundle
 * (vendor/three-roof.min.js, built by scripts/build-three-roof.mjs) and draws:
 *
 *   a gable house · roof deck · drip edge at eaves + rakes · ice & water shield
 *   at the eave · synthetic underlayment · starter strip · shingles · ridge vent
 *   + ridge cap · pipe boot · chimney with step + counter flashing · soffit
 *   intake vents
 *
 * Drag to turn it; the slider pulls the layers apart along the roof; tapping a
 * legend item (or its number) highlights that part. No wheel capture (the
 * page still scrolls). prefers-reduced-motion: no auto-spin. Renders on demand
 * and only while on screen. CSP: external module, no inline handlers.
 */
const ITEMS = [
  { n: 1, key: 'deck' }, { n: 2, key: 'drip' }, { n: 3, key: 'ice' }, { n: 4, key: 'under' },
  { n: 5, key: 'starter' }, { n: 6, key: 'shingles' }, { n: 7, key: 'boot' }, { n: 8, key: 'flash' },
  { n: 9, key: 'ridge' }, { n: 10, key: 'soffit' },
];

export async function mountRoof3d(root) {
  const T = await import('./vendor/three-roof.min.js');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stage = root.querySelector('[data-roof3d-stage]');
  const slider = root.querySelector('[data-roof3d-explode]');
  const legend = root.querySelectorAll('[data-roof3d-item]');
  const canvas = document.createElement('canvas');
  canvas.className = 'roof3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.appendChild(canvas);

  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = T.SRGBColorSpace;
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(32, 1, 0.1, 100);
  scene.add(new T.HemisphereLight(0xffffff, 0xb8a98f, 1.6));
  const sun = new T.DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, 10, 8);
  scene.add(sun);

  // ── materials ──
  const tex = (draw, w = 256, h = 256, rx = 1, ry = 1) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(rx, ry); t.colorSpace = T.SRGBColorSpace;
    return t;
  };
  const siding = tex((g, w, h) => { g.fillStyle = '#ebe4d9'; g.fillRect(0, 0, w, h); g.fillStyle = '#d6ccbd'; for (let y = 0; y < h; y += 16) g.fillRect(0, y, w, 3); }, 256, 256, 3, 2);
  const shingleTex = tex((g, w, h) => {
    g.fillStyle = '#4a5059'; g.fillRect(0, 0, w, h);
    for (let r = 0; r < 8; r++) { const y = r * (h / 8); g.fillStyle = '#30343b'; g.fillRect(0, y, w, 3); for (let x = (r % 2) * 16; x < w; x += 32) g.fillRect(x, y, 2, h / 8); }
  }, 256, 256, 4, 3);
  const deckTex = tex((g, w, h) => { g.fillStyle = '#c8a06a'; g.fillRect(0, 0, w, h); g.fillStyle = '#b38b55'; for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 2, h); for (let y = 0; y < h; y += 128) g.fillRect(0, y, w, 2); }, 256, 256, 3, 2);
  const brick = tex((g, w, h) => { g.fillStyle = '#a3462b'; g.fillRect(0, 0, w, h); g.fillStyle = '#7e3520'; for (let y = 0; y < h; y += 16) { g.fillRect(0, y, w, 2); for (let x = (y / 16 % 2) * 16; x < w; x += 32) g.fillRect(x, y, 2, 16); } }, 128, 128, 1, 2);
  const soffitTex = tex((g, w, h) => { g.fillStyle = '#cfd5dd'; g.fillRect(0, 0, w, h); g.fillStyle = '#5d6673'; for (let x = 8; x < w; x += 24) g.fillRect(x, h * 0.4, 14, h * 0.2); }, 256, 32, 8, 1);
  const M = (o) => new T.MeshStandardMaterial(Object.assign({ roughness: 0.85, metalness: 0 }, o));
  const mat = {
    deck: M({ map: deckTex }), ice: M({ color: 0x2e3440 }), under: M({ color: 0xa9bccf }), starter: M({ color: 0x6b717b }),
    shingles: M({ map: shingleTex }), metal: M({ color: 0xb8bec7, metalness: 0.6, roughness: 0.4 }), ridge: M({ color: 0x2f343b }),
    vent: M({ color: 0x59606b }), wall: M({ map: siding }), trim: M({ color: 0xfbfbfb }), soffit: M({ map: soffitTex }),
    brick: M({ map: brick }), boot: M({ color: 0xbd5728 }), pipe: M({ color: 0xe9e9e9 }), door: M({ color: 0x1a3057 }), glass: M({ color: 0xa9bccf, roughness: 0.2 }),
  };

  // ── house geometry (metres-ish; y up, ridge along x, front = +z) ──
  const Wd = 8, Dp = 6, Hw = 3, OV = 0.4, RK = 0.3;
  const a = Math.atan2(2.2, Dp / 2 + OV);                  // roof pitch
  const L = Math.hypot(Dp / 2 + OV, 2.2);                  // eave → ridge
  const yE = Hw - OV * Math.tan(a);
  const house = new T.Group();
  scene.add(house);
  const parts = {};                                        // item key → meshes (for highlight)
  const tag = (key, m) => { (parts[key] = parts[key] || []).push(m); return m; };
  const box = (w, h, d, m) => new T.Mesh(new T.BoxGeometry(w, h, d), m);

  // walls, gables, door, windows
  const walls = box(Wd, Hw, Dp, mat.wall); walls.position.y = Hw / 2; house.add(walls);
  for (const sx of [-1, 1]) {
    const sh = new T.Shape(); sh.moveTo(-Dp / 2, 0); sh.lineTo(Dp / 2, 0); sh.lineTo(0, (Dp / 2) * Math.tan(a)); sh.lineTo(-Dp / 2, 0);
    const g = new T.Mesh(new T.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: false }), mat.wall);
    g.rotation.y = sx * Math.PI / 2; g.position.set(sx * (Wd / 2 - (sx > 0 ? 0.05 : 0)), Hw, 0); house.add(g);
  }
  const door = box(0.9, 2, 0.05, mat.door); door.position.set(-2.4, 1, Dp / 2 + 0.03); house.add(door);
  for (const x of [0.2, 2.3]) { const w = box(1.3, 0.9, 0.05, mat.glass); w.position.set(x, 1.9, Dp / 2 + 0.03); house.add(w); }

  // roof planes: a layer = box on the plane, offset along the plane's normal
  const planes = [{ side: 1 }, { side: -1 }].map(({ side }) => {
    const g = new T.Group();
    g.position.set(0, yE, side * (Dp / 2 + OV));
    g.rotation.x = side * a;
    if (side < 0) g.rotation.y = Math.PI;                  // back plane faces back
    house.add(g);
    return g;
  });
  const layers = [];                                       // { mesh, k } for the explode slider
  const layer = (plane, key, m, x0, x1, s0, s1, t, k) => {
    const mesh = tag(key, box(x1 - x0, t, s1 - s0, m));
    mesh.userData.base = { x: (x0 + x1) / 2, s: (s0 + s1) / 2, t };
    mesh.position.set((x0 + x1) / 2, 0, -(s0 + s1) / 2);
    plane.add(mesh);
    layers.push({ mesh, k, t });
    return mesh;
  };
  const X0 = -Wd / 2 - RK, X1 = Wd / 2 + RK;
  // front plane: the cutaway staircase (left = finished roof, right = bare deck)
  const F = planes[0], B = planes[1];
  layer(F, 'deck', mat.deck, X0, X1, 0, L, 0.06, 0);
  layer(F, 'ice', mat.ice, X0, 2.9, 0, 1.0, 0.012, 1);
  layer(F, 'under', mat.under, X0, 1.7, 0, L, 0.012, 2);
  layer(F, 'starter', mat.starter, X0, 0.5, 0, 0.3, 0.015, 3);
  layer(F, 'shingles', mat.shingles, X0, 0.5, 0, L, 0.03, 4);
  // drip edge: eave + both rakes (front), metal
  layer(F, 'drip', mat.metal, X0 - 0.03, X1 + 0.03, -0.06, 0.05, 0.02, 0.5);
  layer(F, 'drip', mat.metal, X0 - 0.06, X0, 0, L, 0.08, 0.5);
  layer(F, 'drip', mat.metal, X1, X1 + 0.06, 0, L, 0.08, 0.5);
  // back plane: finished all the way, so the roof reads as a complete gable
  layer(B, 'deck', mat.deck, X0, X1, 0, L, 0.06, 0);
  layer(B, 'under', mat.under, X0, X1, 0, L, 0.012, 2);
  layer(B, 'shingles', mat.shingles, X0, X1, 0, L, 0.03, 4);
  layer(B, 'drip', mat.metal, X0 - 0.03, X1 + 0.03, -0.06, 0.05, 0.02, 0.5);

  // ridge vent + ridge cap along the peak
  const ridgeY = yE + 2.2;
  const vent = tag('ridge', box(X1 - X0, 0.07, 0.42, mat.vent)); vent.position.set(0, ridgeY + 0.08, 0); house.add(vent);
  const cap = tag('ridge', box(X1 - X0, 0.06, 0.5, mat.ridge)); cap.position.set(0, ridgeY + 0.16, 0); house.add(cap);
  layers.push({ mesh: vent, k: 5, t: 0, free: true, base: vent.position.y }, { mesh: cap, k: 6, t: 0, free: true, base: cap.position.y });

  // pipe boot and chimney sit on the front plane's finished side
  const onPlane = (x, s, up) => { const p = new T.Vector3(x, up, -s); F.updateMatrixWorld(); return F.localToWorld(p).sub(house.position); };
  const bootAt = onPlane(-2.9, 1.3, 0.1);
  const pipe = tag('boot', new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 0.6, 16), mat.pipe)); pipe.position.copy(bootAt).add(new T.Vector3(0, 0.25, 0)); house.add(pipe);
  const boot = tag('boot', new T.Mesh(new T.ConeGeometry(0.2, 0.25, 20), mat.boot)); boot.position.copy(bootAt).add(new T.Vector3(0, 0.05, 0)); house.add(boot);
  const chimAt = onPlane(-1.1, 2.0, 0);
  const chim = new T.Mesh(new T.BoxGeometry(0.8, 2.4, 0.8), mat.brick); chim.position.copy(chimAt).add(new T.Vector3(0, 0.75, 0)); house.add(chim);
  const flash = tag('flash', box(1.0, 0.03, 1.0, mat.metal)); flash.position.copy(chimAt).add(new T.Vector3(0, 0.02, 0)); flash.rotation.x = a; house.add(flash);
  const counter = tag('flash', box(0.84, 0.08, 0.84, mat.metal)); counter.position.copy(chimAt).add(new T.Vector3(0, 0.55, 0)); house.add(counter);

  // soffits (front + back) with intake vent slots, and fascia
  for (const sz of [1, -1]) {
    const so = tag('soffit', box(Wd + 0.02, 0.04, OV, mat.soffit)); so.position.set(0, yE - 0.02, sz * (Dp / 2 + OV / 2)); house.add(so);
    const fa = box(X1 - X0, 0.22, 0.04, mat.trim); fa.position.set(0, yE - 0.06, sz * (Dp / 2 + OV)); house.add(fa);
  }
  house.position.y = -2.4;

  // ── explode ──
  let explode = 0;
  const N = new T.Vector3(0, 1, 0);
  function applyExplode() {
    for (const L of layers) {
      if (L.free) { L.mesh.position.y = L.base + explode * L.k * 0.22; continue; }
      L.mesh.position.y = L.t / 2 + (L.k > 0 ? 0.06 : 0) + explode * L.k * 0.32;
    }
    flash.position.y = chimAt.y + 0.02 + explode * 0.9; counter.position.y = chimAt.y + 0.55 + explode * 0.9;
    boot.position.y = bootAt.y + 0.05 + explode * 1.1; pipe.position.y = bootAt.y + 0.25 + explode * 1.1;
  }

  // ── highlight ──
  let active = null;
  function highlight(key) {
    active = active === key ? null : key;
    for (const [k, ms] of Object.entries(parts)) for (const m of ms) {
      if (m.material.emissive) { m.material = m.material.clone(); m.material.emissive.setHex(k === active ? 0xbd5728 : 0x000000); m.material.emissiveIntensity = k === active ? 0.55 : 0; }
    }
    legend.forEach((li) => li.classList.toggle('is-on', li.getAttribute('data-roof3d-item') === active));
    if (active && explode < 0.5) { explode = 0.7; if (slider) slider.value = String(explode * 100); applyExplode(); }
    ask();
  }

  // ── number badges pinned to the model ──
  const anchors = {
    deck: () => onPlane(3.6, 2.3, 0.1), drip: () => onPlane(4.0, 0, 0.1), ice: () => onPlane(2.3, 0.5, 0.15),
    under: () => onPlane(1.2, 2.6, 0.2), starter: () => onPlane(-3.8, 0.15, 0.3), shingles: () => onPlane(-3.4, 2.8, 0.35),
    boot: () => pipe.position.clone().add(new T.Vector3(0, 0.35, 0)), flash: () => flash.position.clone(),
    ridge: () => cap.position.clone().add(new T.Vector3(2.5, 0.1, 0)), soffit: () => new T.Vector3(2.5, yE - 0.1, Dp / 2 + OV / 2),
  };
  const badges = ITEMS.map(({ n, key }) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'roof3d-badge'; b.textContent = String(n);
    b.setAttribute('aria-label', 'Highlight item ' + n);
    b.addEventListener('click', () => highlight(key));
    stage.appendChild(b);
    return { b, key };
  });
  const v = new T.Vector3();
  function placeBadges() {
    const w = stage.clientWidth, h = stage.clientHeight;
    for (const { b, key } of badges) {
      v.copy(anchors[key]());                              // house-local
      house.localToWorld(v);
      v.project(camera);
      // Small stages (phones) only show the highlighted part's number; the legend
      // below the model carries the rest.
      const hidden = v.z > 1 || (w < 520 && key !== active);
      b.style.transform = 'translate(' + ((v.x + 1) / 2 * w - 13).toFixed(1) + 'px,' + ((1 - v.y) / 2 * h - 13).toFixed(1) + 'px)';
      b.hidden = hidden;
    }
  }

  // ── camera orbit (drag) ──
  // Start three-quarters from the front-right so the gable end's peak shows.
  let az = 0.5, el = 0.3, dist = 17;
  function placeCamera() {
    // Narrow stages (phones) back the camera off so the whole house fits.
    const d = dist * Math.max(1, 1.75 / Math.max(0.5, camera.aspect));
    camera.position.set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d);
    camera.lookAt(0, 0.4, 0);
  }
  let dragging = null, spun = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = { x: e.clientX, y: e.clientY, az, el }; spun = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    az = dragging.az - (e.clientX - dragging.x) * 0.008;
    el = Math.max(0.05, Math.min(1.1, dragging.el + (e.clientY - dragging.y) * 0.006));
    ask();
  });
  const stop = () => { dragging = null; };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
  canvas.style.touchAction = 'pan-y';                      // vertical swipes still scroll the page

  if (slider) slider.addEventListener('input', () => { explode = Number(slider.value) / 100; applyExplode(); ask(); });
  legend.forEach((li) => li.addEventListener('click', () => highlight(li.getAttribute('data-roof3d-item'))));

  // ── render on demand, only while visible ──
  let visible = true, queued = false;
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  }
  function frame() {
    queued = false;
    if (!visible) return;
    if (!reduce && !spun) { az += 0.0035; queued = true; requestAnimationFrame(frame); }
    placeCamera();
    renderer.render(scene, camera);
    placeBadges();
  }
  function ask() { if (!queued) { queued = true; requestAnimationFrame(frame); } }
  new ResizeObserver(() => { resize(); ask(); }).observe(stage);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) ask(); }).observe(stage);
  resize(); applyExplode(); ask();
  root.classList.add('is-3d');
  return { highlight, setExplode(x) { explode = x; if (slider) slider.value = String(Math.round(x * 100)); applyExplode(); ask(); }, renderer };
}

// Wire the "See it in 3D" button: nothing heavy loads until it's tapped.
const root = document.querySelector('[data-roof3d]');
if (root) {
  const btn = root.querySelector('[data-roof3d-start]');
  const ok = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (_) { return false; } })();
  if (!ok && btn) btn.hidden = true;
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Loading the 3D roof…';
    try { window.NBDRoof3d = await mountRoof3d(root); btn.hidden = true; }
    catch (e) { btn.disabled = false; btn.textContent = 'See it in 3D'; console.warn('[roof-3d]', e); }
  });
}
