#!/usr/bin/env node
/**
 * scripts/overnight-lh.mjs — local Lighthouse batch runner (mobile + desktop)
 * for a list of paths served by scripts/overnight-serve.mjs (or any base URL).
 *
 *   LIGHTHOUSE_CLI=<dir>/node_modules/lighthouse/cli/index.js \
 *   node scripts/overnight-lh.mjs --base http://127.0.0.1:8080 \
 *        --pages /,/inspect --label before --runs 1 [--out overnight/baseline/lh] [--factor mobile|desktop|both]
 *
 * Writes <out>/<label>/<factor>-<slug>.json (raw LHR, keep out of git) and prints
 * + writes a Markdown summary table to <out>/<label>/summary.md and summary.json.
 * Mobile = Lighthouse default (simulated slow 4G, 4x CPU) with a 390x844 viewport.
 * Median of --runs is reported (by performance score). Read-only: GET requests only.
 * Install Lighthouse outside the repo: npm install --prefix <dir> lighthouse@12
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const CLI = process.env.LIGHTHOUSE_CLI;
if (!CLI) { console.error('Set LIGHTHOUSE_CLI to lighthouse/cli/index.js'); process.exit(2); }
const base = arg('--base', 'http://127.0.0.1:8080');
const pages = (arg('--pages', '/') ).split(',').filter(Boolean);
const label = arg('--label', 'run');
const runs = Math.max(1, Number(arg('--runs', 1)));
const factor = arg('--factor', 'both');
const outDir = join(arg('--out', 'overnight/baseline/lh'), label);
mkdirSync(outDir, { recursive: true });

const slug = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-'));
const factors = factor === 'both' ? ['mobile', 'desktop'] : [factor];
const num = (lhr, id) => { const a = lhr.audits[id]; return a && typeof a.numericValue === 'number' ? a.numericValue : null; };

function extract(lhr) {
  const items = (id) => (lhr.audits[id] && lhr.audits[id].details && lhr.audits[id].details.items) || [];
  const reqs = items('network-requests');
  const biggest = reqs.filter((r) => r.transferSize > 0).sort((a, b) => b.transferSize - a.transferSize).slice(0, 5)
    .map((r) => r.url.replace(/^https?:\/\/[^/]+/, '') .slice(0, 70) + ' ' + Math.round(r.transferSize / 1024) + 'KB');
  const sum = (id, key) => items(id).reduce((s, i) => s + (i[key] || 0), 0);
  return {
    perf: Math.round(lhr.categories.performance.score * 100),
    a11y: Math.round((lhr.categories.accessibility || { score: 0 }).score * 100),
    bp: Math.round((lhr.categories['best-practices'] || { score: 0 }).score * 100),
    seo: Math.round((lhr.categories.seo || { score: 0 }).score * 100),
    fcp: Math.round(num(lhr, 'first-contentful-paint')),
    lcp: Math.round(num(lhr, 'largest-contentful-paint')),
    tbt: Math.round(num(lhr, 'total-blocking-time')),
    cls: Number((num(lhr, 'cumulative-layout-shift') || 0).toFixed(3)),
    si: Math.round(num(lhr, 'speed-index')),
    bytes: Math.round(num(lhr, 'total-byte-weight') || 0),
    requests: reqs.length,
    renderBlocking: items('render-blocking-resources').map((i) => i.url.replace(/^https?:\/\/[^/]+/, '')),
    unusedCssB: sum('unused-css-rules', 'wastedBytes'),
    unusedJsB: sum('unused-javascript', 'wastedBytes'),
    biggest,
    lcpElement: (() => { const n = items('largest-contentful-paint-element')[0]; try { return n.items[0].items[0].node.snippet.slice(0, 90); } catch { return ''; } })(),
    failedA11y: Object.values(lhr.audits).filter((a) => a.score === 0 && lhr.categories.accessibility && lhr.categories.accessibility.auditRefs.some((r) => r.id === a.id)).map((a) => a.id),
  };
}

const results = [];
for (const path of pages) {
  for (const f of factors) {
    const got = [];
    for (let i = 0; i < runs; i++) {
      const out = join(outDir, `${f}-${slug(path)}${runs > 1 ? '-r' + i : ''}.json`);
      const args = [CLI, base + path, '--output=json', '--output-path=' + out, '--quiet',
        '--only-categories=performance,accessibility,best-practices,seo',
        '--chrome-flags=--headless=new --no-sandbox --disable-gpu'];
      if (f === 'desktop') args.push('--preset=desktop');
      else args.push('--screenEmulation.width=390', '--screenEmulation.height=844');
      try {
        execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 240_000 });
        got.push(extract(JSON.parse(readFileSync(out, 'utf8'))));
      } catch (e) { console.warn('LH failed', path, f, i, String(e.message || e).split('\n')[0].slice(0, 160)); }
    }
    got.sort((a, b) => a.perf - b.perf);
    const med = got[Math.floor(got.length / 2)];
    results.push({ path, factor: f, runs: got.length, ...(med || {}) });
    if (med) console.log(`${f.padEnd(7)} ${path.padEnd(42)} P${med.perf} A${med.a11y} B${med.bp} S${med.seo} LCP ${med.lcp} CLS ${med.cls} TBT ${med.tbt} ${Math.round(med.bytes / 1024)}KB ${med.requests}req`);
  }
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results, null, 1));
const rows = results.filter((r) => r.perf !== undefined).map((r) =>
  `| ${r.path} | ${r.factor} | ${r.perf} | ${r.a11y} | ${r.bp} | ${r.seo} | ${r.fcp} | ${r.lcp} | ${r.cls} | ${r.tbt} | ${r.si} | ${Math.round(r.bytes / 1024)} | ${r.requests} | ${Math.round(r.unusedCssB / 1024)}/${Math.round(r.unusedJsB / 1024)} |`);
writeFileSync(join(outDir, 'summary.md'),
  `| Page | Form | Perf | A11y | BP | SEO | FCP ms | LCP ms | CLS | TBT ms | SI ms | KB | Req | Unused CSS/JS KB |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
