#!/usr/bin/env node
/**
 * scripts/measure-compare.js — Google Solar vs Instant Roofer, side by side.
 *
 * WHY THIS EXISTS (documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md, Lane G)
 * Before NBD_MEASUREMENT_PROVIDER flips to `solar` or `auto`, run both
 * providers on ~10 roofs Jo has actually measured and look at the deltas. A
 * wrong measurement becomes a wrong price.
 *
 * WHAT IT DOES
 *   For each target it measures the roof with the Solar adapter
 *   (functions/integrations/solar-measure.js — the exact mapper production
 *   uses) and gets an Instant Roofer figure, then prints the delta in roof
 *   squares (no waste on either side) and in predominant pitch, plus any
 *   manual-check flags Solar raised.
 *
 * TARGETS (any mix):
 *   --lead <leadId>          a CRM lead — reads lat/lng/address (read-only)
 *   --address "<text>"       geocoded with Nominatim (free, street-level —
 *                            prefer a lead or explicit coords)
 *   --at <lat>,<lng>         an explicit rooftop point
 *   --file <path>            one target per line in any of the three forms
 *                            (lead:<id> | at:<lat>,<lng> | anything else = address)
 *
 * INSTANT ROOFER SIDE
 *   --ir existing (default)  for a lead, reuse its existing Instant Roofer
 *                            measurement (lead.measurementJobId) — costs nothing
 *   --ir live                call Instant Roofer now (~$3 each)
 *   --ir none                Solar only
 *
 * SAFETY
 *   Nothing runs without --live (each Solar call is billed; --ir live costs
 *   ~$3 a roof). Read-only against Firestore: no measurement docs, no cache
 *   writes, no lead writes. Keys come from the environment only:
 *     export SOLAR_API_KEY="$(gcloud secrets versions access latest --secret=SOLAR_API_KEY --project nobigdeal-pro)"
 *     export INSTANTROOFER_API_KEY="$(gcloud secrets versions access latest --secret=INSTANTROOFER_API_KEY --project nobigdeal-pro)"   # only for --ir live
 *   Firestore reads use Application Default Credentials (gcloud auth
 *   application-default login).
 *
 * EXAMPLES
 *   node scripts/measure-compare.js --live --lead abc123 --lead def456
 *   node scripts/measure-compare.js --live --file roofs.txt --json out.json
 *   node scripts/measure-compare.js --live --ir none --at 38.99870,-84.62655
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FUNCTIONS = path.join(__dirname, '..', 'functions');

function parseArgs(argv) {
  const o = { live: false, ir: 'existing', targets: [], json: null, project: 'nobigdeal-pro', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--live') o.live = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--lead') { o.targets.push({ kind: 'lead', value: v }); i++; }
    else if (a === '--address') { o.targets.push({ kind: 'address', value: v }); i++; }
    else if (a === '--at') { o.targets.push({ kind: 'at', value: v }); i++; }
    else if (a === '--file') { o.targets.push(...readTargetFile(v)); i++; }
    else if (a === '--ir') { o.ir = v; i++; }
    else if (a === '--json') { o.json = v; i++; }
    else if (a === '--project') { o.project = v; i++; }
    else throw new Error('Unknown argument: ' + a);
  }
  if (!['existing', 'live', 'none'].includes(o.ir)) throw new Error('--ir must be existing | live | none');
  return o;
}

function readTargetFile(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    if (/^lead:/i.test(l)) return { kind: 'lead', value: l.slice(5).trim() };
    if (/^at:/i.test(l)) return { kind: 'at', value: l.slice(3).trim() };
    return { kind: 'address', value: l };
  });
}

const fmt = (n, d) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d == null ? 1 : d) : '—');
const pad = (s, w) => String(s).padEnd(w).slice(0, w);
const rise = (p) => {
  const m = /^(\d+(?:\.\d+)?)\s*(?:[/:]\s*(\d+(?:\.\d+)?))?/.exec(String(p == null ? '' : p).trim());
  if (!m) return null;
  const run = m[2] ? Number(m[2]) : 12;
  return run === 12 ? Number(m[1]) : (Number(m[1]) / run) * 12;
};

async function resolveTarget(t, ctx) {
  if (t.kind === 'at') {
    const [lat, lng] = String(t.value).split(',').map(Number);
    if (!isFinite(lat) || !isFinite(lng)) throw new Error('bad --at ' + t.value);
    return { label: t.value, lat, lng, address: null, lead: null };
  }
  if (t.kind === 'lead') {
    const snap = await ctx.db().doc('leads/' + t.value).get();
    if (!snap.exists) throw new Error('lead not found: ' + t.value);
    const lead = snap.data() || {};
    const c = (typeof lead.lat === 'number' && typeof lead.lng === 'number') ? { lat: lead.lat, lng: lead.lng }
      : (lead.parcel && lead.parcel.center) ? { lat: Number(lead.parcel.center.lat), lng: Number(lead.parcel.center.lng) } : null;
    if (!c) throw new Error('lead ' + t.value + ' has no coordinates — drop a pin on the roof first');
    return { label: 'lead:' + t.value, lat: c.lat, lng: c.lng, address: lead.address || null, lead, leadId: t.value };
  }
  const M = require(path.join(FUNCTIONS, 'integrations', 'measurement.js'));
  const g = await M._test.geocodeNominatim(t.value);
  if (!g) throw new Error('could not geocode: ' + t.value);
  return { label: t.value, lat: g.lat, lng: g.lng, address: t.value, lead: null, precision: g.precision };
}

async function irFigure(target, opts, ctx) {
  if (opts.ir === 'none') return null;
  if (opts.ir === 'existing') {
    const jobId = target.lead && target.lead.measurementJobId;
    if (!jobId) return { error: 'no existing measurement (use --ir live)' };
    const snap = await ctx.db().doc('measurements/' + jobId).get();
    const d = snap.exists ? snap.data() : null;
    if (!d || !d.measurements || !d.measurements.rawSqft) return { error: 'existing measurement has no area' };
    if (d.provider !== 'instantroofer') return { error: 'existing measurement is ' + d.provider + ', not Instant Roofer' };
    return { rawSqft: d.measurements.rawSqft, pitch: d.measurements.pitch, source: 'existing ' + jobId };
  }
  if (!process.env.INSTANTROOFER_API_KEY) return { error: 'INSTANTROOFER_API_KEY not set' };
  const M = require(path.join(FUNCTIONS, 'integrations', 'measurement.js'));
  const r = await M.requestInstantRoofer({ lat: target.lat, lng: target.lng, reportType: 'ai', address: target.address });
  if (!r.ok) return { error: 'Instant Roofer: ' + (r.message || r.reason) };
  return { rawSqft: r.measurements.rawSqft, pitch: r.measurements.pitch, source: 'live' };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.targets.length) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exit(opts.help ? 0 : 1);
  }
  if (!opts.live) {
    console.error('Refusing to run without --live: every Solar call is billed' + (opts.ir === 'live' ? ', and --ir live costs ~$3 a roof' : '') + '.');
    console.error('Targets parsed: ' + opts.targets.length + '. Re-run with --live when the Solar key is set.');
    process.exit(2);
  }
  const apiKey = (process.env.SOLAR_API_KEY || '').trim();
  if (!apiKey || apiKey === '__unset__') {
    console.error('SOLAR_API_KEY is not set in the environment (see the header for the gcloud one-liner).');
    process.exit(2);
  }

  const SOLAR = require(path.join(FUNCTIONS, 'integrations', 'solar-measure.js'));
  let _db = null;
  const ctx = {
    db() {
      if (!_db) {
        const { initAdmin, getFirestore } = require('./_admin');
        initAdmin({ projectId: opts.project });
        _db = getFirestore();
      }
      return _db;
    }
  };

  const rows = [];
  for (const t of opts.targets) {
    const row = { target: t.kind + ':' + t.value };
    try {
      const target = await resolveTarget(t, ctx);
      Object.assign(row, { lat: target.lat, lng: target.lng, address: target.address, geocodePrecision: target.precision || null });
      // requestSolar, not runSolarProvider: no cache, no cap, no Firestore writes.
      const s = await SOLAR.requestSolar({ lat: target.lat, lng: target.lng }, { apiKey });
      if (s.ok) {
        row.solar = {
          rawSqft: s.measurements.rawSqft, roofSquares: s.measurements.roofSquares, pitch: s.measurements.pitch,
          segments: s.measurements.facets, wastePct: s.measurements.wastePct, quality: s.quality,
          imageryDate: s.measurements.imagery.date, flags: s.measurements.manualCheckReasons
        };
      } else row.solar = { error: s.message || s.reason };
      const ir = await irFigure(target, opts, ctx);
      if (ir) row.ir = ir;
      if (row.solar && row.solar.rawSqft && ir && ir.rawSqft) {
        row.deltaSquares = Math.round((row.solar.rawSqft - ir.rawSqft)) / 100;
        row.deltaPct = Math.round(((row.solar.rawSqft - ir.rawSqft) / ir.rawSqft) * 1000) / 10;
        const rs = rise(row.solar.pitch), ri = rise(ir.pitch);
        row.deltaPitch = rs !== null && ri !== null ? Math.round((rs - ri) * 10) / 10 : null;
      }
    } catch (e) {
      row.error = e.message;
    }
    rows.push(row);
  }

  console.log('\n' + pad('target', 30) + pad('solar sq', 10) + pad('IR sq', 9) + pad('Δ sq', 8) + pad('Δ %', 8)
    + pad('solar p', 9) + pad('IR p', 7) + pad('Δ p', 6) + pad('qual', 8) + 'flags / errors');
  for (const r of rows) {
    const s = r.solar || {}, i = r.ir || {};
    const notes = [].concat(r.error || [], s.error || [], i.error || [], s.flags || []).join('; ');
    console.log(pad(r.target, 30)
      + pad(fmt(s.rawSqft != null ? s.rawSqft / 100 : null, 2), 10)
      + pad(fmt(i.rawSqft != null ? i.rawSqft / 100 : null, 2), 9)
      + pad(fmt(r.deltaSquares, 2), 8) + pad(fmt(r.deltaPct, 1), 8)
      + pad(s.pitch || '—', 9) + pad(i.pitch || '—', 7) + pad(fmt(r.deltaPitch, 1), 6)
      + pad(s.quality || '—', 8) + notes);
  }
  const both = rows.filter((r) => typeof r.deltaPct === 'number');
  if (both.length) {
    const meanAbs = both.reduce((a, r) => a + Math.abs(r.deltaPct), 0) / both.length;
    const worst = both.reduce((a, r) => (Math.abs(r.deltaPct) > Math.abs(a.deltaPct) ? r : a));
    const pitchOff = both.filter((r) => r.deltaPitch !== null && Math.abs(r.deltaPitch) >= 1).length;
    console.log('\n' + both.length + ' roofs compared · mean |Δ| ' + meanAbs.toFixed(1) + '% · worst ' + worst.deltaPct + '% (' + worst.target + ') · pitch off by ≥1/12 on ' + pitchOff);
  }
  console.log('Squares are roof surface with NO waste on both sides. Solar is a satellite estimate — confirm on site.');
  if (opts.json) { fs.writeFileSync(opts.json, JSON.stringify(rows, null, 2)); console.log('Wrote ' + opts.json); }
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

module.exports = { parseArgs, readTargetFile, rise };
