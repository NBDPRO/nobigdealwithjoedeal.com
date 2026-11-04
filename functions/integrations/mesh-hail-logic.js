/**
 * integrations/mesh-hail-logic.js — MRMS MESH radar hail grid → hail-size
 * swath polygons for the service area. Pure: no network, no Firestore.
 *
 * WHAT (2026-11-04, documentation/audit/GITHUB-REPO-SWEEP-2026-11-04.md,
 * "Second sweep"): the storm layers so far are POINTS (IEM Local Storm
 * Reports, NCEI SWDI nx3hail cells) and NWS warning polygons. MESH — NOAA
 * MRMS "Maximum Estimated Size of Hail" — is a continuous ~1 km radar grid
 * of estimated hail size, so it draws where hail likely fell between the
 * reports. The 24-hour maximum product is public and keyless on AWS:
 *
 *   https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_Max_1440min_00.50/
 *     YYYYMMDD/MRMS_MESH_Max_1440min_00.50_YYYYMMDD-HHMMSS.grib2.gz
 *
 * FORMAT (checked on a live file 2026-11-04): GRIB2 edition 2, one message.
 *   §3 template 3.0 lat/lon grid, 7000 × 3500, 0.01°, first point
 *      54.995 N / 230.005 E (-129.995), scan mode 0 (rows north→south,
 *      columns west→east).
 *   §5 template 5.41 (PNG packing): value = (R + X·2^E) / 10^D, observed
 *      R = -30, E = 0, D = 1, 16-bit — so mm = (X - 30) / 10. Zero and
 *      negative values are "no hail" / no coverage.
 *   §7 a PNG: 16-bit greyscale, one pixel per grid point.
 * The decoder below reads exactly that shape and THROWS on anything else
 * (another template, bitmap, bit depth), so a format change from NOAA fails
 * the run loudly instead of drawing garbage on a rep's map.
 *
 * HONESTY: MESH is a radar ESTIMATE. It can under- or over-state what hit a
 * roof. The swaths are a canvassing aid only — never a size claim to a
 * homeowner or an adjuster (Kentucky claim-wording rules), and the map title
 * says "radar estimate".
 */
'use strict';

const zlib = require('zlib');

const BASE = 'https://noaa-mrms-pds.s3.amazonaws.com';
const PREFIX = 'CONUS/MESH_Max_1440min_00.50/';

// The service area: Greater Cincinnati + Northern Kentucky with margin
// (storm-watch.js centres Cincinnati metro at 39.10, -84.51). ~1.0° each way.
const SERVICE_BBOX = { minLat: 38.55, maxLat: 39.75, minLon: -85.25, maxLon: -83.65 };

// Bands drawn, inches. Below 0.75" is not worth a knock (hail-cron.js's
// SIZE_THRESHOLD), and each band nests inside the one before it.
const BANDS_IN = [0.75, 1, 1.5, 2];
const MM_PER_IN = 25.4;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// 'YYYY-MM-DD' → 'YYYYMMDD' (validated).
function compactYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) throw new Error('bad ymd: ' + ymd);
  return m[1] + m[2] + m[3];
}

function listUrl(ymd) {
  return BASE + '/?list-type=2&prefix=' + encodeURIComponent(PREFIX + compactYmd(ymd) + '/');
}
function fileUrl(key) { return BASE + '/' + key; }

// S3 ListObjectsV2 XML → keys, sorted.
function parseListXml(xml) {
  const out = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) out.push(m[1]);
  return out.sort();
}

// The file that closes the storm day: the 24-hour max valid at 12:00 UTC
// (8 am EDT / 7 am EST) covers the afternoon and night before. Exactly
// 12:00:00 when present, else the latest file at or before it (MRMS
// occasionally skips a slot). Returns the key or null.
function pickFile(keys, ymdCompact) {
  const want = 'MRMS_MESH_Max_1440min_00.50_' + ymdCompact + '-120000.grib2.gz';
  let best = null;
  for (const k of keys) {
    const name = k.slice(k.lastIndexOf('/') + 1);
    if (name === want) return k;
    const m = /_(\d{8})-(\d{6})\.grib2\.gz$/.exec(name);
    if (m && m[1] === ymdCompact && m[2] <= '120000') best = k;
  }
  return best;
}

// ── GRIB2 ────────────────────────────────────────────────────────────────
function parseGrib2(buf) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'GRIB') throw new Error('not GRIB');
  if (buf[7] !== 2) throw new Error('not GRIB edition 2');
  const out = {};
  let o = 16;
  while (o < buf.length - 4) {
    if (buf.toString('ascii', o, o + 4) === '7777') break;
    const len = buf.readUInt32BE(o);
    const n = buf[o + 4];
    if (len < 5 || o + len > buf.length) throw new Error('bad GRIB2 section length');
    if (n === 3) {
      if (buf.readUInt16BE(o + 12) !== 0) throw new Error('grid template is not 3.0');
      out.ni = buf.readUInt32BE(o + 30);
      out.nj = buf.readUInt32BE(o + 34);
      out.lat1 = buf.readInt32BE(o + 46) / 1e6;
      let lon1 = buf.readUInt32BE(o + 50) / 1e6;
      if (lon1 > 180) lon1 -= 360;
      out.lon1 = lon1;
      out.di = buf.readUInt32BE(o + 63) / 1e6;
      out.dj = buf.readUInt32BE(o + 67) / 1e6;
      out.scan = buf[o + 71];
      if (out.scan !== 0) throw new Error('unexpected scan mode ' + out.scan);
    } else if (n === 5) {
      if (buf.readUInt16BE(o + 9) !== 41) throw new Error('data template is not 5.41 (PNG)');
      out.R = buf.readFloatBE(o + 11);
      out.E = buf.readInt16BE(o + 15);
      out.D = buf.readInt16BE(o + 17);
      out.bits = buf[o + 19];
    } else if (n === 6) {
      if (buf[o + 5] !== 255) throw new Error('bitmap present — not handled');
    } else if (n === 7) {
      out.png = buf.subarray(o + 5, o + len);
    }
    o += len;
  }
  if (!out.ni || !out.png || out.R == null) throw new Error('GRIB2 message incomplete');
  return out;
}

// ── PNG (16-bit greyscale, non-interlaced) → rows [r0, r1) as Uint16Array ─
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePngRows(png, r0, r1) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not PNG');
  let o = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.toString('ascii', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 16 || color !== 0 || interlace !== 0) throw new Error('PNG is not 16-bit grey, non-interlaced');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 2, stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error('PNG data short');
  const rows = Math.max(0, Math.min(r1, h) - r0);
  const out = new Uint16Array(rows * w);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < Math.min(r1, h); y++) {
    const base = y * (stride + 1);
    const ft = raw[base];
    for (let x = 0; x < stride; x++) {
      const v = raw[base + 1 + x];
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let r;
      if (ft === 0) r = v;
      else if (ft === 1) r = v + a;
      else if (ft === 2) r = v + b;
      else if (ft === 3) r = v + ((a + b) >> 1);
      else if (ft === 4) r = v + paeth(a, b, c);
      else throw new Error('bad PNG filter ' + ft);
      cur[x] = r & 0xff;
    }
    if (y >= r0) {
      const off = (y - r0) * w;
      for (let i = 0; i < w; i++) out[off + i] = (cur[2 * i] << 8) | cur[2 * i + 1];
    }
    const t = prev; prev = cur; cur = t;
  }
  return { w, h, rows, data: out };
}

// GRIB2 + bbox → { grid: Float32Array (mm, row-major north→south), cols,
// rows, lat0 (north edge row centre), lon0 (west col centre), d }.
function cropMm(g, bbox) {
  const b = bbox || SERVICE_BBOX;
  const r0 = Math.max(0, Math.floor((g.lat1 - b.maxLat) / g.dj));
  const r1 = Math.min(g.nj, Math.ceil((g.lat1 - b.minLat) / g.dj) + 1);
  const c0 = Math.max(0, Math.floor((b.minLon - g.lon1) / g.di));
  const c1 = Math.min(g.ni, Math.ceil((b.maxLon - g.lon1) / g.di) + 1);
  const png = decodePngRows(g.png, r0, r1);
  if (png.w !== g.ni) throw new Error('PNG width ' + png.w + ' ≠ grid ' + g.ni);
  const cols = c1 - c0, rows = r1 - r0;
  const grid = new Float32Array(cols * rows);
  const scale = Math.pow(2, g.E), div = Math.pow(10, g.D);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = (g.R + png.data[y * png.w + c0 + x] * scale) / div;
      grid[y * cols + x] = v > 0 ? v : 0;
    }
  }
  return { grid, cols, rows, lat0: g.lat1 - r0 * g.dj, lon0: g.lon1 + c0 * g.di, d: g.di };
}

// ── Mask → polygons ─────────────────────────────────────────────────────
// Cells at or above `mm` become one boundary per connected region. Each
// grid cell is a d×d square centred on its point; boundary edges are walked
// with the inside on the LEFT, so outer rings come out counter-clockwise in
// (x right, y up) and holes clockwise. Collinear vertices are dropped, which
// is lossless for an axis-aligned cell boundary.
function traceBand(c, mm) {
  const { grid, cols, rows } = c;
  const inside = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x] >= mm;
  // Vertex (i, j): i = 0..cols, j = 0..rows (j counts DOWN from the north edge).
  const key = (i, j) => i * (rows + 2) + j;
  const next = new Map(); // start vertex → [end vertices]
  const add = (a, b) => { const k = key(a[0], a[1]); const l = next.get(k); if (l) l.push(b); else next.set(k, [b]); };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!inside(x, y)) continue;
      // Screen coords (j down); inside-on-left in y-up means walking
      // west→east along a cell's SOUTH edge, etc.
      if (!inside(x, y + 1)) add([x, y + 1], [x + 1, y + 1]);       // south: west→east
      if (!inside(x + 1, y)) add([x + 1, y + 1], [x + 1, y]);       // east: south→north
      if (!inside(x, y - 1)) add([x + 1, y], [x, y]);               // north: east→west
      if (!inside(x - 1, y)) add([x, y], [x, y + 1]);               // west: north→south
    }
  }
  const rings = [];
  for (;;) {
    let startKey = null;
    for (const [k, l] of next) { if (l.length) { startKey = k; break; } }
    if (startKey == null) break;
    const si = Math.floor(startKey / (rows + 2)), sj = startKey % (rows + 2);
    const ring = [[si, sj]];
    let pi = si, pj = sj, dir = null;
    for (let guard = 0; guard < 4 * (cols + 1) * (rows + 1) + 4; guard++) {
      const l = next.get(key(pi, pj));
      if (!l || !l.length) break;
      // At a saddle (two ways out) take the LEFT-most turn, which keeps
      // diagonal-touching cells as separate rings.
      let pick = 0;
      if (l.length > 1 && dir) {
        const score = (b) => {
          const nd = [b[0] - pi, b[1] - pj];
          // cross of dir × nd in screen coords; left turn in y-up = negative here
          return dir[0] * nd[1] - dir[1] * nd[0];
        };
        let bestScore = Infinity;
        l.forEach((b, i) => { const s = score(b); if (s < bestScore) { bestScore = s; pick = i; } });
      }
      const b = l.splice(pick, 1)[0];
      dir = [b[0] - pi, b[1] - pj];
      pi = b[0]; pj = b[1];
      if (pi === si && pj === sj) break;
      ring.push([pi, pj]);
    }
    rings.push(dropCollinear(ring));
  }
  return rings;
}

function dropCollinear(ring) {
  const n = ring.length;
  if (n < 4) return ring;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = ring[(k - 1 + n) % n], b = ring[k], c = ring[(k + 1) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

// Signed area in vertex units, y-up. > 0 = counter-clockwise = outer ring.
function signedArea(ring) {
  let s = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    s += a[0] * (-b[1]) - b[0] * (-a[1]);
  }
  return s / 2;
}

// Walking a→b (vertex units, j down), the band cell sits at offset
// (dy, -dx)/2 from the edge midpoint — see the four add() calls above.
function bandSidePoint(ring) {
  const a = ring[0], b = ring[1];
  const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
  return [a[0] + dx * 0.5 + dy * 0.5, a[1] + dy * 0.5 - dx * 0.5];
}

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Vertex (i, j) → [lat, lng], rounded to 4 dp (~10 m).
function toLatLng(c, v) {
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  return [r4(c.lat0 + c.d / 2 - v[1] * c.d), r4(c.lon0 - c.d / 2 + v[0] * c.d)];
}

// One band → [{ outer: [[lat,lng],...], holes: [[[lat,lng],...]], cells }].
// Regions smaller than minCells (default 2 cells, ~2 km²) are radar specks.
function bandPolygons(c, mm, minCells) {
  const min = minCells == null ? 2 : minCells;
  const rings = traceBand(c, mm);
  const outers = [], holes = [];
  rings.forEach((r) => { const a = signedArea(r); if (a > 0) outers.push({ r, a }); else if (a < 0) holes.push(r); });
  return outers
    .filter((o) => o.a >= min)
    .map((o) => ({
      outer: o.r.map((v) => toLatLng(c, v)),
      // Every ring keeps the band on its walking side: half a cell off its
      // first edge, on that side, is the centre of a band cell — strictly
      // inside exactly the outer ring that encloses the hole.
      holes: holes.filter((h) => { const m = bandSidePoint(h); return pointInRing(m[0], m[1], o.r); })
        .map((h) => h.map((v) => toLatLng(c, v))),
      cells: o.a
    }));
}

function maxMm(c) {
  let m = 0;
  for (let k = 0; k < c.grid.length; k++) if (c.grid[k] > m) m = c.grid[k];
  return m;
}

// The whole day → the stored document (Firestore can't hold nested arrays,
// so the polygons ride as one JSON string).
function buildDayDoc(c, meta) {
  const bands = BANDS_IN.map((inches) => ({ minIn: inches, polygons: bandPolygons(c, inches * MM_PER_IN) }))
    .filter((b) => b.polygons.length);
  const maxIn = Math.round(maxMm(c) / MM_PER_IN * 100) / 100;
  return {
    ymd: meta.ymd,
    sourceKey: meta.key,
    product: 'MRMS MESH_Max_1440min',
    bbox: meta.bbox || SERVICE_BBOX,
    maxIn,
    bandCount: bands.length,
    polygonCount: bands.reduce((s, b) => s + b.polygons.length, 0),
    bandsJson: JSON.stringify(bands)
  };
}

module.exports = {
  BASE, PREFIX, SERVICE_BBOX, BANDS_IN, MM_PER_IN,
  compactYmd, listUrl, fileUrl, parseListXml, pickFile,
  parseGrib2, decodePngRows, cropMm,
  traceBand, signedArea, bandPolygons, maxMm, buildDayDoc,
  _pad2: pad2
};
