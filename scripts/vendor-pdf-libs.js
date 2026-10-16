#!/usr/bin/env node
/**
 * scripts/vendor-pdf-libs.js — rebuild the vendored client PDF libraries
 * (repos report 2026-10-16, item 2). Run by hand when bumping a version;
 * the output is committed under docs/assets/vendor/.
 *
 * Why a build and not a copy:
 *   Both of html2pdf.js 0.14.0's dist files (html2pdf.bundle.min.js AND
 *   html2pdf.min.js) carry their own jsPDF 4.0.0 inside, which is still
 *   affected by GHSA-wfv2-pwc8-crg5, GHSA-7x6v-j9x4-qf24, GHSA-p5xg-68wr-hm3m,
 *   GHSA-9vjf-qc39-jprp, GHSA-67pg-wm7f-q7fj, GHSA-pqxr-3g65-p328,
 *   GHSA-95fx-jjr5-f39c, GHSA-vm32-vv63-w422 and GHSA-cjw8-79x6-5cj4 (fixed
 *   in 4.1.0 to 4.2.1). Shipping either would also keep the double jsPDF
 *   download the `pdfexport` bundle has today (standalone jsPDF + the copy
 *   inside html2pdf). So html2pdf is built from its own published src/ with
 *   esbuild, bundling html2canvas + DOMPurify, and its `jspdf` import is
 *   pointed at the ONE standalone jsPDF the page already loaded
 *   (window.jspdf, from jspdf.umd.min.js, which must load first: the
 *   ScriptLoader runs a bundle's files in order).
 *
 * Output (versioned directories, so the URL changes with the version and no
 * cache can serve an old copy):
 *   docs/assets/vendor/jspdf/<JSPDF>/jspdf.umd.min.js   (upstream file, byte-identical)
 *   docs/assets/vendor/html2pdf/<HTML2PDF>/html2pdf.nbd.min.js
 *   docs/assets/vendor/html2pdf/<HTML2PDF>/LICENSES.txt
 *
 * Needs the pinned esbuild (node scripts/minify-shipped.js --install), npm
 * and tar on PATH. Downloads the four npm tarballs into a fresh temp dir.
 *
 * Usage: node scripts/vendor-pdf-libs.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadEsbuild } = require('./minify-shipped.js');

const VERSIONS = { jspdf: '4.2.1', 'html2pdf.js': '0.14.0', html2canvas: '1.4.1', dompurify: '3.4.17' };
const REPO = path.join(__dirname, '..');
const VENDOR = path.join(REPO, 'docs', 'assets', 'vendor');

function sh(cmd, args, cwd) { return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' }).toString(); }

function fetchPackages() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-pdf-libs-'));
  const dirs = {};
  for (const [name, ver] of Object.entries(VERSIONS)) {
    const tgz = sh('npm', ['pack', name + '@' + ver, '--silent'], tmp).trim().split(/\r?\n/).pop();
    const sub = name.replace(/[^a-z0-9]/gi, '_');
    const out = path.join(tmp, sub);
    fs.mkdirSync(out);
    // Relative paths: GNU tar (Git Bash) reads "C:\..." as a remote host.
    sh('tar', ['-xzf', tgz, '-C', sub], tmp);
    dirs[name] = path.join(out, 'package');
    const pj = JSON.parse(fs.readFileSync(path.join(dirs[name], 'package.json'), 'utf8'));
    if (pj.version !== ver) throw new Error(name + ' tarball is ' + pj.version + ', wanted ' + ver);
  }
  return { tmp, dirs };
}

async function build() {
  const esbuild = loadEsbuild();
  if (!esbuild) throw new Error('pinned esbuild missing: node scripts/minify-shipped.js --install');
  const { tmp, dirs } = fetchPackages();

  // 1. jsPDF: the upstream UMD build, unchanged.
  const jspdfOut = path.join(VENDOR, 'jspdf', VERSIONS.jspdf);
  fs.mkdirSync(jspdfOut, { recursive: true });
  fs.copyFileSync(path.join(dirs.jspdf, 'dist', 'jspdf.umd.min.js'), path.join(jspdfOut, 'jspdf.umd.min.js'));

  // 2. html2pdf from src, jsPDF taken from the page's global.
  const shim = {
    name: 'nbd-pdf-resolve',
    setup(b) {
      b.onResolve({ filter: /^jspdf(\/.*)?$/ }, () => ({ path: 'jspdf-global', namespace: 'nbd' }));
      b.onLoad({ filter: /^jspdf-global$/, namespace: 'nbd' }, () => ({
        loader: 'js',
        contents: "if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('html2pdf: load jspdf.umd.min.js first');\n" +
          'export const jsPDF = window.jspdf.jsPDF;\nexport default window.jspdf;\n',
      }));
      b.onResolve({ filter: /^html2canvas$/ }, () => ({ path: path.join(dirs.html2canvas, 'dist', 'html2canvas.esm.js') }));
      b.onResolve({ filter: /^dompurify$/ }, () => ({ path: path.join(dirs.dompurify, 'dist', 'purify.es.mjs') }));
    },
  };
  const banner = '/*! html2pdf.js ' + VERSIONS['html2pdf.js'] + ' (MIT) built from src/ for NBD by scripts/vendor-pdf-libs.js with html2canvas ' +
    VERSIONS.html2canvas + ' (MIT) and DOMPurify ' + VERSIONS.dompurify + ' (Apache-2.0 OR MPL-2.0) bundled; jsPDF is NOT bundled: it uses window.jspdf (jsPDF ' +
    VERSIONS.jspdf + ', loaded first). Licenses: LICENSES.txt */';
  const r = await esbuild.build({
    entryPoints: [path.join(dirs['html2pdf.js'], 'src', 'index.js')],
    bundle: true, write: false, format: 'iife', globalName: '__nbdHtml2pdf',
    footer: { js: 'window.html2pdf=__nbdHtml2pdf.default;' },
    banner: { js: banner },
    minify: true, target: 'safari15', legalComments: 'none', charset: 'utf8',
    plugins: [shim], logLevel: 'warning',
  });
  const h2pOut = path.join(VENDOR, 'html2pdf', VERSIONS['html2pdf.js']);
  fs.mkdirSync(h2pOut, { recursive: true });
  fs.writeFileSync(path.join(h2pOut, 'html2pdf.nbd.min.js'), r.outputFiles[0].text);
  const lic = (name, file) => '==== ' + name + ' ' + VERSIONS[name] + ' (' + file + ') ====\n\n' + fs.readFileSync(path.join(dirs[name], file), 'utf8').trim() + '\n\n';
  fs.writeFileSync(path.join(h2pOut, 'LICENSES.txt'),
    lic('html2pdf.js', 'LICENSE') + lic('html2canvas', 'LICENSE') + lic('dompurify', 'LICENSE'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('wrote ' + path.relative(REPO, path.join(jspdfOut, 'jspdf.umd.min.js')) + ' and ' + path.relative(REPO, path.join(h2pOut, 'html2pdf.nbd.min.js')));
}

if (require.main === module) build().catch((e) => { console.error(e); process.exit(1); });
module.exports = { VERSIONS };
