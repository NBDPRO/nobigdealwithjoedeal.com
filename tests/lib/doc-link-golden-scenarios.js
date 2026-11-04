'use strict';
/**
 * Drives getSharedReport through the legacy-link scenarios and returns what a
 * customer (and Firestore) saw, as a stable JSON-able object. The committed
 * hashes in tests/doc-link-2026-11-04.test.js were produced by running this
 * against the report-sharing.js on origin/main BEFORE the Secure Document Link
 * change (dba5aae8..db0e4b4d), so "flag off is byte-identical" compares the new
 * file with the old behaviour, not with itself.
 *
 *   node tests/lib/doc-link-golden-scenarios.js <path-to-report-sharing.js>
 */
const path = require('path');
const crypto = require('crypto');
const world = require('./doc-link-world');
const { W, DB, mkReq, mkRes, flush, Timestamp, UPLOAD_PATH, baseWorld } = world;

const FAR = Timestamp.fromMillis(4102444800000);
const PAST = Timestamp.fromMillis(1000);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const plain = (d) => JSON.parse(JSON.stringify(d, (k, v) => (v && v._ts ? 'TS:' + v.toMillis() : v)));

async function run(sharePath) {
  delete process.env.SECURE_DOC_LINK_ENABLED;
  const SHARE = require(sharePath);
  const out = {};
  async function scenario(name, docs, req, setup) {
    baseWorld(docs);
    W.now = 1790000000000;
    if (setup) setup();
    const res = mkRes();
    await SHARE.getSharedReport(req, res);
    await flush();
    const body = res.bytes() || (typeof res.body === 'string' ? res.body : JSON.stringify(res.body || ''));
    const hdr = {}; Object.keys(res.headers).sort().forEach((k) => { hdr[k] = res.headers[k]; });
    out[name] = {
      status: res.statusCode, headers: hdr, bodySha: sha(body), bodyLen: body.length,
      docs: sha(JSON.stringify(plain(W.docs))), pushes: W.pushes.length,
    };
  }
  const TOK = 'ABCDEFGHJKLMNPQRSTUV2345';
  const lead = (extra) => Object.assign({
    kind: 'lead_document', purpose: 'estimate_review', ownerUid: 'u1', companyId: 'u1', leadId: 'lead-1', documentId: 'doc-1',
    status: 'active', expiresAt: FAR, storagePath: UPLOAD_PATH, filename: 'Smith_Estimate.pdf', docLabel: 'Smith_Estimate.pdf', customerName: 'Smith',
  }, extra || {});
  const get = (p, h) => mkReq({ method: 'GET', path: p, headers: h });

  await scenario('legacy_pdf', { ['report_share_tokens/' + TOK]: lead() }, get('/report/' + TOK));
  await scenario('legacy_pdf_bot', { ['report_share_tokens/' + TOK]: lead() }, get('/report/' + TOK, { 'user-agent': 'facebookexternalhit/1.1' }));
  await scenario('legacy_pdf_trailing_slash', { ['report_share_tokens/' + TOK]: lead() }, get('/report/' + TOK + '/'));
  await scenario('legacy_pdf_not_pdf', { ['report_share_tokens/' + TOK]: lead() }, get('/report/' + TOK), () => { W.objects[UPLOAD_PATH].body = '<html>x</html>'; });
  await scenario('legacy_pdf_html_type', { ['report_share_tokens/' + TOK]: lead() }, get('/report/' + TOK), () => { W.objects[UPLOAD_PATH].meta.contentType = 'text/html'; });
  await scenario('legacy_pdf_bad_path', { ['report_share_tokens/' + TOK]: lead({ storagePath: 'photos/u1/x.pdf' }) }, get('/report/' + TOK));
  await scenario('legacy_pdf_missing_object', { ['report_share_tokens/' + TOK]: lead({ storagePath: 'docs/u1/lead-1_9_gone.pdf' }) }, get('/report/' + TOK));
  await scenario('legacy_html_report', {
    ['report_share_tokens/' + TOK]: { kind: 'report', reportId: 'rep-1', ownerUid: 'u1', status: 'active', expiresAt: FAR },
    'reports/rep-1': { userId: 'u1', html: '<html><body>Inspection</body></html>' },
  }, get('/report/' + TOK));
  await scenario('revoked', { ['report_share_tokens/' + TOK]: lead({ status: 'revoked' }) }, get('/report/' + TOK));
  await scenario('expired', { ['report_share_tokens/' + TOK]: lead({ expiresAt: PAST }) }, get('/report/' + TOK));
  await scenario('unknown', {}, get('/report/' + TOK));
  await scenario('invalid_path', {}, get('/report/short'));
  await scenario('sub_file_path_is_invalid', { ['report_share_tokens/' + TOK]: lead() }, get('/report/' + TOK + '/file'));
  await scenario('sub_unlock_path_is_invalid', { ['report_share_tokens/' + TOK]: lead() }, mkReq({ method: 'POST', path: '/report/' + TOK + '/unlock', body: { code: 'x' } }));
  return out;
}

module.exports = { run };

if (require.main === module) {
  run(path.resolve(process.argv[2])).then((o) => { console.log(JSON.stringify(o, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
