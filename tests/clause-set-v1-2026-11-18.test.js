/**
 * clause-set-v1-2026-11-18.test.js — phase 2 of the template/liability overhaul: the clause set
 * printed on the contract-class signing paths, behind the per-user flag docClauseSetV1 (default OFF).
 * See documentation/projects/CLAUSE-SET-V1-2026-11-18.md.
 *
 *   A. flag OFF is byte-identical to today (golden hashes recorded from origin/main before any
 *      renderer changed: client contract / proposal / work authorization HTML, the server e-sign PDF)
 *   ...later sections are added with each step.
 *
 * Run: node tests/clause-set-v1-2026-11-18.test.js   (needs functions/node_modules for pdf-lib)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./helpers/clause-v1-harness');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  section('A. flag OFF is byte-identical to the render recorded before phase 2');
  {
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clause-set-v1-golden.json'), 'utf8'));
    const now = await H.goldens();
    ok('the golden fixture covers six contract variants, two proposals, two work authorizations and three PDFs',
      Object.keys(golden).length === 13, String(Object.keys(golden).length));
    Object.keys(golden).forEach((k) => ok('flag off: ' + k + ' is byte-identical to origin/main', now[k] === golden[k], String(now[k]).slice(0, 12) + ' vs ' + String(golden[k]).slice(0, 12)));
    // A flag that is explicitly false, or absent, is the same as off.
    const envOff = H.docs({ flags: { docClauseSetV1: false } });
    ok('flag explicitly false: contract unchanged', H.sha(H.render(envOff, 'renderContract', H.VARIANTS.ky_cash)) === golden['contract.ky_cash']);
    // The other flag alone changes nothing in the rendered text either.
    const envEv = H.docs({ flags: { docEvidenceFoundation: true } });
    ok('docEvidenceFoundation on, docClauseSetV1 off: contract unchanged', H.sha(H.render(envEv, 'renderContract', H.VARIANTS.oh_cash)) === golden['contract.oh_cash']);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('B. the registry text is the packet text (fixture: tests/fixtures/attorney-packet-2026-11-18.md, a copy of the section-3 packet on origin/docs/attorney-review-packet)');
  const CS = require('../functions/clause-set.js');
  const TXT = require('../functions/clause-set-text.js');
  const K = require('../functions/ky-insurance-law.js');
  {
    const read = (p) => fs.readFileSync(path.join(H.ROOT, p), 'utf8').replace(/\r\n/g, '\n');
    ok('clause-set.js, clause-set-text.js: server copy is the browser copy, byte for byte',
      read('docs/pro/js/clause-set.js') === read('functions/clause-set.js') && read('docs/pro/js/clause-set-text.js') === read('functions/clause-set-text.js'));
    ok('CLAUSE_SET_VERSION was bumped past .1', /^CS-2026-11-18\.([2-9]|\d{2,})$/.test(CS.CLAUSE_SET_VERSION), CS.CLAUSE_SET_VERSION);
    const packet = read('tests/fixtures/attorney-packet-2026-11-18.md');
    const s3 = packet.slice(packet.indexOf('## 3. The clause text'), packet.indexOf('## 4. Which document carries'));
    const blocks = {}; let cur = null;
    s3.split('\n').forEach((ln) => {
      const h = ln.match(/^#### ([A-Z]+-\d+)\b/);
      if (h) { cur = h[1]; blocks[cur] = []; return; }
      if (/^#{1,3} /.test(ln)) { cur = null; return; }
      if (cur && ln.startsWith('>')) blocks[cur].push(ln.replace(/^> ?/, ''));
    });
    const paras = (id) => {
      const out = []; let p = [];
      (blocks[id] || []).forEach((l) => { if (l.trim() === '') { if (p.length) out.push(p.join(' ')); p = []; } else p.push(l); });
      if (p.length) out.push(p.join(' '));
      return out;
    };
    const norm = (t) => t.replace(/\*\*/g, '').replace(/^\*[^*]+:\* /, '').replace(/\s+/g, ' ').trim();
    const DEFAULTS = Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { cardFeePct: 3 });
    const fill = (t) => t.replace(/\{\{cfg\$:deckingPerSheetCents\}\}/, '{{decking price per 4 ft by 8 ft sheet, from your estimate}}')
      .replace(/\{\{cfg:([A-Za-z]+)\}\}/g, (m, k) => String(DEFAULTS[k]));
    // Packet paragraphs the registry deliberately does not carry, with the reason.
    const NOT_PRINTED = { 'PARTY-1': [1], 'WAR-2': [1], 'DISP-6': [1] };
    const ids = Object.keys(TXT.CLAUSES);
    ok('40 text clauses registered (plus the by-reference ones: PAY-2, WAR-4, INS-1, INS-3, INS-4, LIEN-3, CANC-1)', ids.length === 40 && CS.V1_IDS.length === 47, ids.length + '/' + CS.V1_IDS.length);
    ids.forEach((id) => {
      const pk = paras(id).map(norm);
      const parts = TXT.CLAUSES[id].parts.filter((p) => p.only !== 'tenant');
      parts.forEach((p, i) => {
        const t = norm(fill(p.text));
        ok(id + ' part ' + i + ' is in the packet verbatim', pk.some((x) => x.includes(t)), t.slice(0, 60));
      });
      pk.forEach((x, i) => {
        if ((NOT_PRINTED[id] || []).indexOf(i) !== -1) return;
        ok(id + ' packet paragraph ' + i + ' is printed', parts.some((p) => x.startsWith(norm(fill(p.text)))), x.slice(0, 60));
      });
    });
    ok('INS-1 is the shipped PAYMENT_CLAUSE and LIEN-3 the shipped KY_LIEN_CLAUSE (by reference; the shipped text has a curly apostrophe where the packet has a straight one, the shipped constant controls)',
      paras('INS-1').map(norm)[0] === K.PAYMENT_CLAUSE.replace(/’/g, "'") && paras('LIEN-3').map(norm)[0] === K.KY_LIEN_CLAUSE);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('C. variants: what prints for {OH,KY} x {cash,insurance,financed}, and unknown = Kentucky insurance');
  {
    const terms = CS.paymentTermsFor({ cardFeePct: 3, deckingPerSheetCents: 10000 }, true);
    const party = CS.partyFor({}, true);
    const R = (state, src, extra) => CS.renderV1(Object.assign({ state, paymentSource: src, terms, party, facts: { ownerNames: 'Jane', propertyAddress: '1 A St', date: 'Nov 18', companyPhone: '(859) 555-0100' } }, extra || {}));
    const ids = (r) => r.refs.map((x) => x.replace(/_V\d+$/, ''));
    const has = (r, id) => ids(r).indexOf(id) !== -1;
    const ohc = R('OH', 'cash'), ohi = R('OH', 'insurance'), kyc = R('KY', 'cash'), kyi = R('KY', 'insurance'), fin = R('OH', 'financed'), unk = R('', '');
    ok('OH cash: Ohio lien text, no insurance or Kentucky clauses', has(ohc, 'LIEN-1') && !has(ohc, 'LIEN-2') && !has(ohc, 'LIEN-3') && !has(ohc, 'INS-2') && !has(ohc, 'LATE-5') && !has(ohc, 'PAY-6'));
    ok('OH insurance: deductible, no-discount, supplements, payment source; no Kentucky notices or no-assignment', has(ohi, 'INS-2') && has(ohi, 'LATE-5') && has(ohi, 'CO-3') && has(ohi, 'PAY-6') && has(ohi, 'LIEN-1') && !has(ohi, 'INS-4') && !has(ohi, 'INS-5') && !has(ohi, 'LIEN-3'));
    ok('KY cash: Kentucky lien text and the Kentucky fee limit, no insurance clauses', has(kyc, 'LIEN-2') && !has(kyc, 'LIEN-1') && !has(kyc, 'INS-2') && kyc.sections.some((s) => s.items.some((i) => i.id === 'LATE-3' && i.paragraphs.length === 2)));
    ok('KY insurance: the by-reference statutory set (LIEN-3, INS-1, INS-3, INS-4), no-assignment, PAY-4 insurer sentence, no card fee',
      ['LIEN-3', 'INS-1', 'INS-3', 'INS-4', 'INS-5', 'INS-2', 'LATE-5'].every((i) => has(kyi, i)) && !has(kyi, 'LIEN-1') && !has(kyi, 'LIEN-2')
      && kyi.sections.some((s) => s.items.some((i) => i.id === 'PAY-4' && i.paragraphs.length === 2))
      && !JSON.stringify(kyi.sections).includes('Credit card fee'));
    ok('financed: payment-source paragraph plus the lender sentence; the cash lien', has(fin, 'PAY-6') && fin.sections.some((s) => s.items.some((i) => i.id === 'PAY-6' && i.paragraphs.length === 2)) && has(fin, 'LIEN-1') && !has(fin, 'INS-2'));
    ok('unknown state and source = exactly the Kentucky-insurance set (fail closed)', JSON.stringify(unk.refs) === JSON.stringify(kyi.refs) && unk.failClosed === true && unk.variant === 'KY.insurance');
    ok('an unknown payment source alone is strict (insurance), a state outside OH/KY reads as Ohio text', R('KY', '').variant === 'KY.insurance' && R('IN', 'cash').variant === 'OH.cash');
    ok('the card-fee paragraphs print on OH and KY cash, not on Kentucky insurance', JSON.stringify(ohc.sections).includes('3% of the amount') && JSON.stringify(kyc.sections).includes('3% of the amount') && !JSON.stringify(kyi.sections).includes('3% of the amount'));
    const off = CS.renderV1({ state: 'OH', paymentSource: 'cash', terms: CS.paymentTermsFor({ deckingPerSheetCents: 10000 }, true), party, facts: {} });
    ok('cardFeePct 0: no document promises a card fee (PAY-7 keeps ways to pay and returned payments)',
      !/credit card fee|Refunds of card fees|3%/i.test(JSON.stringify(off.sections)) && /Ways to pay with no added fee/.test(JSON.stringify(off.sections)) && /Returned payments/.test(JSON.stringify(off.sections)));
    ok('no PAY-3 without milestones, PAY-3 with them', !has(ohc, 'PAY-3') && has(R('OH', 'cash', { facts: { milestones: ['Start 40%', 'Dry-in 40%', 'Done 20%'] } }), 'PAY-3'));
    ok('every variant records every clause it prints (refs = the printed items, plus PARTY-1)', [ohc, ohi, kyc, kyi, fin, unk].every((r) => r.refs.length === r.sections.reduce((n, s) => n + s.items.length, 0) + 1));
    ok('describeV1 keeps the shipped statutory refs and adds the v1 refs once each', (() => {
      const d = CS.describeV1({ state: 'KY', paymentSource: 'insurance' });
      const refs = d.clauses.map((c) => c.ref);
      return refs.indexOf('PAYMENT_V1') !== -1 && refs.indexOf('KY_INS_LIEN_V1') !== -1 && refs.indexOf('PAY-4_V1') !== -1 && new Set(refs).size === refs.length && d.clauseSetVersion === CS.CLAUSE_SET_VERSION;
    })());
    ok('legacy describeFor is unchanged (six clauses at most)', CS.describeFor({ state: 'KY', paymentSource: 'insurance' }).clauses.length === 6);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('D. config-driven numbers: no hard-coded number in a clause, unset = missing, tenant never inherits NBD numbers');
  {
    const base = { state: 'OH', paymentSource: 'cash', party: CS.partyFor({}, true), facts: {} };
    const mk = (over) => CS.renderV1(Object.assign({}, base, { terms: CS.paymentTermsFor(over, true) }));
    const text = (r) => JSON.stringify(r.sections);
    ok('NBD defaults are the nine decided numbers', JSON.stringify(CS.NBD_PAYMENT_TERMS_DEFAULTS) === JSON.stringify({ lateGraceDays: 15, lateInterestPct: 8, disputeDays: 10, finalPaymentDays: 7, punchListDays: 3, pauseNoticeDays: 5, restockPct: 15, cardFeePct: 0, deckingPerSheetCents: null, deckingSheetsBeforeChangeOrder: 10, atticFreeCheckDays: 3, claimNoticeDays: 30 }));
    const r1 = mk({ lateGraceDays: 21, lateInterestPct: 6, disputeDays: 12, finalPaymentDays: 9, punchListDays: 4, pauseNoticeDays: 8, restockPct: 10, deckingPerSheetCents: 12550, deckingSheetsBeforeChangeOrder: 6, claimNoticeDays: 45 });
    const t1 = text(r1);
    ok('each number in the text follows the config (changing the config changes the paper)',
      /within 21 days after its due date, simple interest at 6% per year/.test(t1) && /within 12 days of the invoice date/.test(t1) && /within 9 days after NBD sends/.test(t1)
      && /within 4 days of the walkthrough/.test(t1) && /within 8 days after NBD/.test(t1) && /lesser of 10% of/.test(t1) && /\$125\.50 per sheet/.test(t1)
      && /up to 6 sheets/.test(t1) && /more than 6 sheets/.test(t1) && /within 45 days of finding/.test(t1) && r1.missing.length === 0, r1.missing.join());
    ok('deckingPerSheetCents unset: missing (the send gate refuses) and the text keeps a visible token, never an invented price', JSON.stringify(mk({}).missing) === '["deckingPerSheetCents"]' && /\{\{deckingPerSheetCents\}\}/.test(text(mk({}))));
    ok('a zero price per sheet is not a price', JSON.stringify(mk({ deckingPerSheetCents: 0 }).missing) === '["deckingPerSheetCents"]');
    const tenant = CS.renderV1(Object.assign({}, base, { party: CS.partyFor({ entityName: 'Oaks Roofing LLC' }, false), terms: CS.paymentTermsFor({}, false) }));
    ok('a tenant with nothing set is missing every clause number (never NBD\'s)', tenant.missing.length === 10 && tenant.missing.indexOf('lateGraceDays') !== -1 && tenant.missing.indexOf('deckingPerSheetCents') !== -1, tenant.missing.join());
    ok('a tenant\'s paper names its own entity and never NBD', /Oaks Roofing LLC/.test(JSON.stringify(tenant.party)) && !/\bNBD\b|No Big Deal|Joe Deal/.test(JSON.stringify(tenant.sections) + JSON.stringify(tenant.party)));
    ok('the clause code holds no clause number: changing a default changes nothing in the text', !/\b(15|8|10|7|5)% ?per year|\b15 days\b/.test(fs.readFileSync(path.join(H.ROOT, 'functions/clause-set.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('E. banned phrases over every rendered variant');
  {
    const BANNED = [/\blicensed\b/i, /in-?house/i, /we(?:'ll| will)? handle/i, /personally/i, /lifetime/i, /\bguarantee[sd]?\b/i, /\bW-?2\b/, /we will get (?:your|the) (?:claim|supplement)/i, /\bwaive(?:s|d)? (?:your|the) deductible/i];
    const party = CS.partyFor({}, true);
    [['OH', 'cash'], ['OH', 'insurance'], ['KY', 'cash'], ['KY', 'insurance'], ['OH', 'financed'], ['', '']].forEach(([st, src]) => {
      const r = CS.renderV1({ state: st, paymentSource: src, party, terms: CS.paymentTermsFor({ cardFeePct: 3, deckingPerSheetCents: 10000 }, true), facts: { milestones: ['A'] } });
      const t = r.sections.map((s) => s.items.map((i) => i.paragraphs.join(' ')).join(' ')).join(' ');
      BANNED.forEach((re) => ok('variant ' + r.variant + ' (' + (st || '?') + '/' + (src || '?') + '): no ' + re, !re.test(t.replace(/Contractor will not file or claim a mechanic's lien/, ''))));
    });
    const scan = require('./lib/outbound-template-scan');
    ok('the clause wording files are on the outbound-template banned-phrase scan list', scan.TEMPLATE_FILES.indexOf('docs/pro/js/clause-set-text.js') !== -1);
    const hits = scan.scanFile('docs/pro/js/clause-set-text.js');
    ok('the existing scanner finds nothing in the new wording', Array.isArray(hits) ? hits.length === 0 : !hits, JSON.stringify(hits).slice(0, 200));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
