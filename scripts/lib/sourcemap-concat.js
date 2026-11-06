'use strict';
/**
 * scripts/lib/sourcemap-concat.js — one flat v3 source map for a file made by joining other files line-aligned
 * (2026-11-06). Used by scripts/concat-shipped.js --maps-dir so Sentry can map frames inside the deploy-joined
 * _concat-*.js / _bundle-*.js files back to the readable source.
 *
 * joinMaps(parts) — parts: [{ lineOffset, lines, map, source, content }] in output order, where
 *   lineOffset = the 0-based output line the part's text starts on (each part starts at column 0);
 *   lines      = how many lines of the part's text are in the output;
 *   map        = the part's own v3 map (object or JSON string) when it has one (a minified file), else null;
 *   source/content = the readable file's path and text, used when map is null: each line maps to itself.
 * A flat map (not an index map with `sections`) so every consumer reads it.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = Object.fromEntries([...B64].map((c, i) => [c, i]));

function encodeVlq(n) {
  let v = n < 0 ? ((-n) << 1) | 1 : n << 1;
  let out = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v > 0) d |= 32;
    out += B64[d];
  } while (v > 0);
  return out;
}

function decodeVlqSegment(s) {
  const out = [];
  let val = 0, shift = 0;
  for (const ch of s) {
    const d = B64I[ch];
    if (d === undefined) throw new Error('sourcemap-concat: bad base64 digit ' + JSON.stringify(ch));
    val += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    out.push(val & 1 ? -(val >>> 1) : val >>> 1);
    val = 0; shift = 0;
  }
  if (shift) throw new Error('sourcemap-concat: truncated VLQ');
  return out;
}

/** mappings string -> [[ [genCol, src?, line?, col?, name?] ... ] per line], all ABSOLUTE. */
function decodeMappings(mappings) {
  let src = 0, line = 0, col = 0, name = 0;
  return String(mappings).split(';').map((l) => {
    let gen = 0;
    return l ? l.split(',').filter(Boolean).map((seg) => {
      const f = decodeVlqSegment(seg);
      gen += f[0];
      if (f.length === 1) return [gen];
      src += f[1]; line += f[2]; col += f[3];
      if (f.length >= 5) { name += f[4]; return [gen, src, line, col, name]; }
      return [gen, src, line, col];
    }) : [];
  });
}

/** Absolute decoded lines -> mappings string. */
function encodeMappings(lines) {
  let src = 0, line = 0, col = 0, name = 0;
  return lines.map((segs) => {
    let gen = 0;
    return segs.map((s) => {
      let out = encodeVlq(s[0] - gen); gen = s[0];
      if (s.length >= 4) {
        out += encodeVlq(s[1] - src) + encodeVlq(s[2] - line) + encodeVlq(s[3] - col);
        src = s[1]; line = s[2]; col = s[3];
        if (s.length >= 5) { out += encodeVlq(s[4] - name); name = s[4]; }
      }
      return out;
    }).join(',');
  }).join(';');
}

function joinMaps(parts, file) {
  const sources = [], sourcesContent = [], names = [];
  const lines = [];
  for (const p of parts) {
    while (lines.length < p.lineOffset) lines.push([]);
    let decoded;
    if (p.map) {
      const m = typeof p.map === 'string' ? JSON.parse(p.map) : p.map;
      if (m.sections) throw new Error('sourcemap-concat: index maps are not supported as input');
      const sBase = sources.length, nBase = names.length;
      (m.sources || []).forEach((s, i) => { sources.push(s); sourcesContent.push(m.sourcesContent ? (m.sourcesContent[i] ?? null) : null); });
      (m.names || []).forEach((n) => names.push(n));
      decoded = decodeMappings(m.mappings || '').map((segs) => segs.map((s) => {
        if (s.length === 1) return s;
        const o = [s[0], s[1] + sBase, s[2], s[3]];
        if (s.length >= 5) o.push(s[4] + nBase);
        return o;
      }));
    } else {
      const si = sources.length;
      sources.push(p.source);
      sourcesContent.push(p.content == null ? null : p.content);
      decoded = [];
      for (let i = 0; i < p.lines; i++) decoded.push([[0, si, i, 0]]);
    }
    decoded = decoded.slice(0, p.lines);
    for (let i = 0; i < decoded.length; i++) {
      const at = p.lineOffset + i;
      while (lines.length <= at) lines.push([]);
      lines[at] = lines[at].concat(decoded[i]);
    }
  }
  const out = { version: 3, sources, sourcesContent, names, mappings: encodeMappings(lines) };
  if (file) out.file = file;
  return out;
}

module.exports = { joinMaps, decodeMappings, encodeMappings, encodeVlq, decodeVlqSegment };
