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

  // ═══════════════════════════════════════════════════════════════════════
  section('F. the client contract, flag ON');
  {
    const strip = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
    const PRICED = { companyProfile: undefined };
    const withTerms = (env, v, extra) => {
      const W = env.win;
      const cp = H.profileFor(W, H.BIZ_ADDR, Object.assign({
        paymentMethodsNoCash: 'All payments by check. No cash payments accepted. Late payments subject to a 1.5% monthly finance charge.',
        changeOrderClause: 'NBD reserves the right to adjust pricing and completion dates.',
        cancellationContractClause: 'You may cancel as permitted by Kentucky Revised Statutes § 367.390.',
        disputeResolutionClause: 'Disputes go to mediation or binding arbitration under Kentucky law.',
        entireAgreementClause: 'LEGACY-ENTIRE-AGREEMENT',
      }, (extra && extra.cp) || {}));
      cp.paymentTerms = Object.assign({}, W.NBD_COMPANY_PROFILE_DEFAULTS.paymentTerms, { deckingPerSheetCents: 10000 }, (extra && extra.terms) || {});
      return H.render(env, 'renderContract', v, { companyProfile: cp });
    };
    const on = H.docs({ flags: { docClauseSetV1: true } });
    const off = H.docs({});
    const out = {};
    Object.keys(H.VARIANTS).forEach((k) => { out[k] = withTerms(on, H.VARIANTS[k]); });
    const t = {}; Object.keys(out).forEach((k) => { t[k] = strip(out[k]); });

    ok('the party block names the LLC d/b/a and signs "By: Joe Deal, Manager"', Object.keys(t).every((k) => /No Big Deal Solutions LLC, a Kentucky limited liability company, doing business as No Big Deal Home Solutions/.test(t[k]) && /No Big Deal Solutions LLC d\/b\/a No Big Deal Home Solutions - By: Joe Deal, Manager/.test(out[k].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '))));
    ok('NBD is defined once, as the Contractor, and the homeowner and address are the contract\'s own', /\("NBD" or "Contractor"\), and Jane Smith \("you" or "Homeowner"\), the owner\(s\) of the property at 1 Elm St, Cincinnati, OH 45202\./.test(t.oh_cash) && /Contract date: November 18, 2026/.test(t.oh_cash));
    ok('the legacy contradictory clauses are replaced, not stacked (no cash ban, finance charge, arbitration, KRS 367.390, unilateral price change)',
      Object.keys(t).every((k) => !/No cash payments|finance charge|binding arbitration|367\.390|reserves the right to adjust|LEGACY-ENTIRE-AGREEMENT/i.test(t[k])));
    ok('flag off with the same legacy profile still prints those legacy clauses (the swap is the flag, not the profile)', /No cash payments accepted/.test(strip(withTerms(off, H.VARIANTS.oh_cash))) && /binding arbitration/.test(strip(withTerms(off, H.VARIANTS.oh_cash))));
    ok('the new clauses print: late interest at the configured 8% after 15 days, mediation first, governing law, restocking, decking at $100.00',
      /within 15 days after its due date, simple interest at 8% per year/.test(t.oh_cash) && /we will try mediation before filing suit/.test(t.oh_cash)
      && /The law of the state where the property is located governs this contract\./.test(t.oh_cash) && /lesser of 15% of the price NBD paid/.test(t.oh_cash) && /\$100\.00 per sheet/.test(t.oh_cash));
    ok('no card-fee promise while cardFeePct is 0', Object.keys(t).every((k) => !/credit card fee/i.test(t[k]) && /Zelle, check, ACH bank transfer, wire transfer and cash/.test(t[k])));
    ok('Ohio gets the Ohio lien text; Kentucky cash the Kentucky one; Kentucky insurance the no-excess sentence only',
      /Ohio law lets a contractor/.test(t.oh_cash) && /Kentucky law lets a contractor who has not been paid file a lien statement/.test(t.ky_cash)
      && /Contractor will not file or claim a mechanic's lien for any amount in excess/.test(t.ky_insurance) && !/Kentucky law lets a contractor/.test(t.ky_insurance) && !/Ohio law lets a contractor/.test(t.ky_insurance));
    ok('unknown state with insurance is the Kentucky-insurance contract', /Contractor will not file or claim a mechanic's lien for any amount in excess/.test(t.unknown_insurance) && /You may cancel this contract at any time before midnight on the fifth business day/.test(t.unknown_insurance));

    // Kentucky insurance: every statutory block is byte-for-byte what the flag-off contract printed.
    const region = (h, from, to) => { const a = h.indexOf(from); if (a < 0) return null; const b = h.indexOf(to, a + from.length); return h.slice(a, b < 0 ? undefined : b); };
    const offKy = withTerms(off, H.VARIANTS.ky_insurance);
    ['<!-- PAYMENT (every contract', '<!-- KRS 367.624(3) NOTICES'].forEach((m) => {
      const end = '</div>\n            </div>';
      const a = region(offKy, m, end), b = region(out.ky_insurance, m, end);
      ok('KY insurance: the block starting ' + m + ' is byte-identical to the flag-off contract', a !== null && a === b, String(a).slice(0, 40));
    });
    const tailOf = (h) => h.slice(h.indexOf('data-nbd-noc="ftc"') - 400);
    ok('KY insurance: the notice-of-cancellation forms and the cancel packet (after the signatures) are byte-identical',
      region(offKy, 'class="nbd-cxl-receipt"', '</body>') === region(out.ky_insurance, 'class="nbd-cxl-receipt"', '</body>') && tailOf(offKy).length > 500);
    ok('KY insurance: the FTC statement beside the signatures is unchanged', region(offKy, '<!-- SIGNATURES -->', 'signature-block') === region(out.ky_insurance, '<!-- SIGNATURES -->', 'signature-block'));
    ok('KY insurance: the shipped lien sentence is printed with the same markup as before', out.ky_insurance.includes('<div style="margin: 0.1in 0; font-size: 10px;">Contractor will not file or claim a mechanic&#39;s lien') || /Contractor will not file or claim a mechanic(&#39;|')s lien for any amount in excess of what your insurer pays or is expected to pay\./.test(out.ky_insurance));

    // Every printed clause is recorded, and the marker the server reads says so.
    const refsIn = (h) => { const m = /<!-- nbd:clause-set (CS-[0-9.-]+) ([^ ]+) -->/.exec(h); return m ? { version: m[1], refs: m[2].split(',') } : null; };
    Object.keys(out).forEach((k) => {
      const m = refsIn(out[k]);
      const v = H.VARIANTS[k];
      const j = on.win.NBDJurisdiction.classify({ address: v.address, jobType: v.jobType, claimNumber: v.claimNumber });
      const expect = CS.renderV1({ state: j.state, paymentSource: j.insurance ? 'insurance' : (v.jobType === 'finance' ? 'financed' : 'cash'), terms: CS.paymentTermsFor({ deckingPerSheetCents: 10000 }, true), party: CS.partyFor({}, true), hasWarranty: true });
      ok(k + ': the document carries a marker listing every printed clause, at the current version', !!m && m.version === CS.CLAUSE_SET_VERSION && m.refs.length > 30);
      const printed = (out[k].match(/data-clause="([A-Z]+-\d+)"/g) || []).map((x) => x.replace(/data-clause="|"/g, ''));
      ok(k + ': every clause whose text is printed is in the marker', printed.every((id) => m.refs.indexOf(id + '_V1') !== -1), printed.filter((id) => m.refs.indexOf(id + '_V1') === -1).join());
      ok(k + ': the marker matches the registry for this variant (modulo the warranty section)', JSON.stringify(m.refs.filter((r) => !/^WAR-4/.test(r))) === JSON.stringify(expect.refs.filter((r) => !/^WAR-4/.test(r))), m.refs.length + ' vs ' + expect.refs.length);
    });

    // The send gate: an unset clause number refuses with the rep message; a tenant never inherits NBD's numbers.
    const unset = withTerms(on, H.VARIANTS.oh_cash, { terms: { deckingPerSheetCents: null } });
    ok('an unset decking price leaves a visible token, never an invented price', /\{\{deckingPerSheetCents\}\}/.test(unset) && !/\$0\.00 per sheet/.test(unset));
    const Checks = require('../functions/doc-send-checks.js');
    const gaps = Checks.contractGaps({ type: 'contract', priceCents: 1850000, address: 'a', homeownerName: 'b', mailingAddress: 'c', needsMailingAddress: true, entityName: 'X LLC', startDate: 's', estimatedCompletion: 'e', text: unset, clauseConfigMissing: ['deckingPerSheetCents'] });
    ok('the send check refuses with "Set deckingPerSheetCents in Company Profile." and does not repeat it as a placeholder', gaps.length === 1 && gaps[0].code === 'clauseConfig' && gaps[0].message === 'Set deckingPerSheetCents in Company Profile.', JSON.stringify(gaps));
    ok('doc-send-checks.js twin pair is byte-identical', H.read('docs/pro/js/doc-send-checks.js').replace(/\r\n/g, '\n') === H.read('functions/doc-send-checks.js').replace(/\r\n/g, '\n'));
    ok('the generator send gate derives the missing list from the document and refuses (client)', (() => {
      const W = on.win; const before = on.toasts.length;
      const okSend = W.NBDDocGen._docSendGate('contract', { homeownerName: 'Jane', address: H.OH_ADDR, contractPrice: '$18,500.00', startDate: 'x', estimatedCompletion: 'y', companyProfile: H.profileFor(W, H.BIZ_ADDR) }, unset);
      return okSend === false && on.toasts.slice(before).some((x) => /Set deckingPerSheetCents in Company Profile/.test(x.m));
    })());
    ok('the gate stays quiet for a flag-off render', off.win.NBDDocGen._docSendGate('contract', {}, '<p>{{deckingPerSheetCents}}</p>') === true);

    // Tenant: its own name, no NBD names anywhere, numbers blank until it sets them.
    const tenantBrand = { legalName: 'Oaks Roofing', entityName: 'Oaks Roofing LLC', dbaName: 'Oaks Roofing', signerTitle: 'Owner', colors: {}, contact: { email: 'a@oaks.test', phone: '(513) 555-0100' } };
    const ten = H.docs({ flags: { docClauseSetV1: true }, brand: tenantBrand });
    const tHtml = H.render(ten, 'renderContract', H.VARIANTS.oh_cash, { companyProfile: Object.assign(H.profileFor(ten.win, H.BIZ_ADDR), { paymentTerms: {} }) });
    const tt = strip(tHtml);
    ok('a tenant\'s contract names its own LLC and signer title and no NBD names', /Oaks Roofing LLC d\/b\/a Oaks Roofing - By: ______________, Owner/.test(tHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) && !/\bNBD\b|No Big Deal|Joe Deal/i.test((tHtml.match(/data-clause="[^"]+"[^>]*>.*?<\/div>/g) || []).join(' ').replace(/<[^>]*>/g, ' ')), (tt.match(/.{20}(NBD|No Big Deal|Joe Deal).{20}/i) || [''])[0]);
    ok('a tenant with no numbers set shows the tokens (the gate then refuses)', /\{\{lateGraceDays\}\}/.test(tHtml) && /\{\{deckingPerSheetCents\}\}/.test(tHtml));
    // company-profile.js: defaults, and the tenant blanking
    const D = on.win.NBD_COMPANY_PROFILE_DEFAULTS;
    ok('company-profile.js paymentTerms defaults equal the registry\'s NBD defaults', JSON.stringify(D.paymentTerms) === JSON.stringify(CS.NBD_PAYMENT_TERMS_DEFAULTS));
    ok('_legal() blanks the numbers for a non-NBD tenant that kept the defaults, keeps the ones it changed', (() => {
      const w = ten.win; w._companyProfile = Object.assign({}, w.NBD_COMPANY_PROFILE_DEFAULTS, { brand: Object.assign({}, w.NBD_COMPANY_PROFILE_DEFAULTS.brand, { legalName: 'Oaks Roofing' }), paymentTerms: Object.assign({}, D.paymentTerms, { lateGraceDays: 20 }) });
      const pt = w._legal().paymentTerms;
      return pt.lateGraceDays === 20 && pt.lateInterestPct === null && pt.restockPct === null && w._legal().paymentTerms.deckingPerSheetCents === null;
    })());
    ok('_legal() leaves NBD\'s own numbers alone', (() => { const w = on.win; w._companyProfile = JSON.parse(JSON.stringify(D)); return w._legal().paymentTerms.lateGraceDays === 15; })());
    ok('a flag-off contract carries no marker and none of the new text', !/nbd:clause-set/.test(withTerms(off, H.VARIANTS.oh_cash)) && !/Costs of enforcing/.test(withTerms(off, H.VARIANTS.oh_cash)));
    // banned phrases over the rendered contracts
    Object.keys(t).forEach((k) => ok(k + ': rendered contract has no banned phrase', !/\blicensed\b|in-house|we(?:'ll| will)? handle|personally|lifetime/i.test(t[k].replace(/personally inspected/, ''))));
    void PRICED;
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('G. the server e-sign estimate PDF, flag ON');
  {
    const DE = require('../functions/doc-evidence.js');
    const KyLaw = require('../functions/ky-insurance-law.js');
    const pdfLib = require(path.join(H.ROOT, 'functions/node_modules/pdf-lib'));
    const drawn = [];
    const orig = pdfLib.PDFPage.prototype.drawText;
    pdfLib.PDFPage.prototype.drawText = function (t, o) { drawn.push(String(t)); return orig.call(this, t, o); };
    const lead = (addr, jobType) => ({ address: addr, jobType, userId: 'u1' });
    const build = async (state, jobType, profile, flagOn) => {
      drawn.length = 0;
      const addr = state === 'KY' ? H.KY_ADDR : H.OH_ADDR;
      const cs = flagOn ? DE.buildClauseSet(KyLaw, lead(addr, jobType), {}, profile, '', { ownerNames: 'Jane Smith and Pat Smith', propertyAddress: addr, date: 'November 18, 2026' }) : null;
      const r = await H.esignPdf(state, { clauseSet: cs, failClosed: !!flagOn, entityName: 'No Big Deal Solutions LLC' });
      return { r, cs, text: drawn.join(' ').replace(/\s+/g, ' ') };
    };
    const nbdProfile = { paymentTerms: { deckingPerSheetCents: 10000 }, brand: { contact: { mailingAddress: H.BIZ_ADDR } } };
    const oh = await build('OH', 'cash', nbdProfile, true);
    ok('PDF flag on: the party block, the clause text and the signer line print', /PARTY-1 Parties\. This contract is between No Big Deal Solutions LLC, a Kentucky limited liability company, doing business as No Big Deal Home Solutions/.test(oh.text) && /No Big Deal Solutions LLC d\/b\/a No Big Deal Home Solutions/.test(oh.text) && /By: Joe Deal, Manager/.test(oh.text));
    ok('PDF flag on: the shipped Payment clause and the cancellation forms are still there', oh.text.includes(KyLaw.PAYMENT_CLAUSE.replace(/\u2019/g, "'")) && /NOTICE OF CANCELLATION/.test(oh.text) && oh.text.includes(KyLaw.FTC_STATEMENT));
    ok('PDF flag on: late interest, mediation, decking at $100.00 and the Ohio lien text print; no Kentucky text on an Ohio job',
      /within 15 days after its due date, simple interest at 8% per year/.test(oh.text) && /mediation before filing suit/.test(oh.text) && /\$100\.00 per sheet/.test(oh.text) && /Ohio law lets a contractor/.test(oh.text) && !/BUYER'S RIGHT TO CANCEL/.test(oh.text));
    ok('PDF flag on: the clauses it printed are returned for the evidence record (and nothing statutory-by-reference is faked)', Array.isArray(oh.r.clauseRefs) && oh.r.clauseRefs.length > 30 && oh.r.clauseRefs.indexOf('PARTY-1_V1') !== -1 && oh.r.clauseRefs.indexOf('PAY-4_V1') !== -1);
    const stamp = DE.stampFor(KyLaw, lead(H.OH_ADDR, 'cash'), {}, { refs: oh.r.clauseRefs });
    ok('the envelope stamp: the shipped statutory refs plus every v1 ref, at the current version', stamp.clauseSetVersion === CS.CLAUSE_SET_VERSION && stamp.clauseIds.indexOf('PAYMENT_V1') !== -1 && stamp.clauseIds.indexOf('PAY-4_V1') !== -1 && new Set(stamp.clauseIds).size === stamp.clauseIds.length && stamp.clauseIds.length <= 60, stamp.clauseIds.length);
    ok('a forged ref the registry does not know is not recorded', DE.stampFor(KyLaw, lead(H.OH_ADDR, 'cash'), {}, { refs: ['EVIL-9_V1', 'PAY-4_V1'] }).clauseIds.indexOf('EVIL-9_V1') === -1);
    const ky = await build('KY', 'cash', nbdProfile, true);
    ok('PDF flag on, Kentucky cash: the Kentucky lien and BUYER\'S RIGHT TO CANCEL both print', /Kentucky law lets a contractor who has not been paid/.test(ky.text) && /BUYER'S RIGHT TO CANCEL/.test(ky.text));
    const fin = await build('OH', 'finance', nbdProfile, true);
    ok('PDF flag on, financed: the lender sentence prints', /Your lender's terms control your loan\./.test(fin.text));
    ok('PDF flag on: legacy wording is not there and no banned phrase is', [oh, ky, fin].every((x) => !/licensed|in-house|finance charge|binding arbitration|No cash payments|personally|lifetime/i.test(x.text)));
    ok('PDF flag on, cardFeePct 0: no card fee promised', !/credit card fee/i.test(oh.text) && /Zelle, check, ACH bank transfer/.test(oh.text));
    let refused = null;
    try { await build('OH', 'cash', { brand: nbdProfile.brand }, true); } catch (e) { refused = e; }
    ok('PDF flag on with the decking price unset: the build refuses (clauseConfig gap), nothing is generated', !!refused && Array.isArray(refused.gaps) && refused.gaps.some((g) => g.code === 'clauseConfig' && g.message === 'Set deckingPerSheetCents in Company Profile.'), refused && refused.message);
    const tenantPdf = await build('OH', 'cash', { paymentTerms: Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 9000 }), brand: { entityName: 'Oaks Roofing LLC', dbaName: 'Oaks Roofing', signerTitle: 'Owner', legalName: 'Oaks Roofing', contact: { phone: '(513) 555-0100', mailingAddress: '1 B St' } } }, false)
      .catch(() => null);
    void tenantPdf;
    pdfLib.PDFPage.prototype.drawText = orig;
    // flag off: nothing is added (the golden bytes in section A are the proof); and the returned object has no refs
    const offPdf = await H.esignPdf('OH');
    ok('PDF flag off: no clause refs returned and the golden bytes hold', offPdf.clauseRefs === null);
    const tenantSet = DE.buildClauseSet(KyLaw, lead(H.OH_ADDR, 'cash'), {}, { paymentTerms: {}, brand: { entityName: 'Oaks Roofing LLC', legalName: 'Oaks Roofing', signerTitle: 'Owner', contact: { phone: '(513) 555-0100' } } }, 'someOtherTenantUid', {});
    ok('a tenant\'s PDF clause set: its own entity, no NBD name or phone, every number missing until set', /Oaks Roofing LLC/.test(tenantSet.partyBlock.nameLine) && !/NBD|No Big Deal|Joe Deal|420-7382/.test(JSON.stringify(tenantSet.sections) + JSON.stringify(tenantSet.party) + tenantSet.partyBlock.byLine) && tenantSet.missing.length === 10);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('H. the deal page, flag ON (server side: mint, serve, accept)');
  {
    const kit = require('./lib/doc-evidence-kit');
    const DE = require('../functions/doc-evidence.js');
    const ESL = require('../functions/esign-logic.js');
    const FN = path.join(H.ROOT, 'functions');
    const DEAL_PATH = 'deal_rooms/U1/deal0001.html';
    const REALD = ['./cancel-notice-pdf', './job-spine-logic', './deal-packet-logic', './lead-artifact-paths', './await-briefly', './portal-after-signing', './signed-price', './customer-estimate-rows', './doc-send-checks', 'crypto'];
    const stubs = () => ({
      './deal-install-date': { fillLeadInstallDate: async () => null },
      './deal-view-logic': { isPreviewBot: () => false, shouldNotifyView: () => false, viewMessage: () => ({ title: '', body: '' }) },
      './estimate-send-logic': {}, './thursday-video-gate': { isNbdTenant: () => false, DEAL_ROOM_INJECT: '', DEAL_ROOM_SCRIPT_PATH: '/x.js' },
      './deal-accepted-tier': { applyAcceptedTier: async () => {} },
      './ky-insurance-law': K, './cancel-window': require(path.join(FN, 'cancel-window.js')), './esign-logic': ESL, './doc-evidence': DE,
    });
    const PAGE = '<html><head></head><body><p>Your roof, three packages.</p><div class="section-title">Sign &amp; Schedule</div><div class="sign-section">sign</div></body></html>';
    const terms = Object.assign({}, CS.NBD_PAYMENT_TERMS_DEFAULTS, { deckingPerSheetCents: 10000 });
    const world = (flags, termsOverride) => kit.makeDb({
      'deal_rooms/deal0001': { status: 'sent', userId: 'U1', leadId: 'L1', customerName: 'Dana Whitfield', tiers: { better: { price: 13000 } } },
      'leads/L1': { userId: 'U1', companyId: 'U1', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash' },
      'companyProfile/U1': { paymentTerms: termsOverride === undefined ? terms : termsOverride, brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', signerTitle: 'Owner', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202', phone: '(513) 555-0100' } } },
      'feature_flags/_default': flags,
    });
    const load = (db, st) => kit.loadHandler('deal-acceptance.js', db, st, stubs(), REALD);
    const mint = async (db, st) => { const L = load(db, st); try { return { L, out: await L.fns.createDealAcceptToken({ auth: { uid: 'U1', token: {} }, data: { dealId: 'deal0001' } }) }; } catch (e) { return { L, err: e }; } };
    const view = async (L, token) => {
      const res = { statusCode: 200, headers: {}, sent: '', status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; }, send(b) { this.sent = b; return this; }, json(b) { this.sent = JSON.stringify(b); return this; } };
      const c = kit.reqRes({}, {}); c.req.method = 'GET'; c.req.path = '/deal/' + token; await L.fns.getDealRoom(c.req, res); return res;
    };
    let db = world({ docClauseSetV1: true }); let st = kit.makeStorage({ [DEAL_PATH]: PAGE });
    let m = await mint(db, st);
    const tok = m.out ? (db._get('deal_accept_tokens/' + m.out.token) || {}) : {};
    ok('mint, flag on: the token keeps the clause set it minted (refs, version, html)', !!m.out && !!tok.clauseSetV1 && tok.clauseSetV1.version === CS.CLAUSE_SET_VERSION && tok.clauseSetV1.refs.indexOf('PARTY-1_V1') !== -1 && /Acme Roofing LLC/.test(tok.clauseSetV1.html), m.err && m.err.message);
    ok('the tenant\'s block names its own LLC and carries no NBD name', !!tok.clauseSetV1 && !/NBD|No Big Deal|Joe Deal/.test(tok.clauseSetV1.html));
    const served = m.out ? await view(m.L, m.out.token) : { sent: '' };
    const at = served.sent.indexOf('data-nbd-clause-set'), sign = served.sent.indexOf('<div class="section-title">Sign');
    ok('serve, flag on: the clause block is on the page, before the signature section', at > 0 && sign > at && /within 15 days after its due date/.test(served.sent), String(at) + '/' + sign);
    ok('serve: the stored page is otherwise untouched (injection only)', served.sent.replace(/<div data-nbd-clause-set[\s\S]*?<\/div>(?=<div class="section-title">)/, '').indexOf('Your roof, three packages.') > 0);
    const acc = kit.reqRes({ token: m.out && m.out.token, tier: 'better', signature: 'data:image/png;base64,' + 'A'.repeat(400), financing: -1, consent: true }, { ip: '198.51.100.20', ua: 'Mozilla/5.0 DealPhone' });
    if (m.out) await m.L.fns.submitDealAcceptance(acc.req, acc.res);
    const ev = (db._get('deal_rooms/deal0001') || {}).acceptedEvidence || {};
    ok('accept: the evidence records the version and every clause the page printed', acc.res.statusCode === 200 && ev.clauseSetVersion === CS.CLAUSE_SET_VERSION && ev.clauseIds.indexOf('PARTY-1_V1') !== -1 && ev.clauseIds.indexOf('PAY-4_V1') !== -1 && ev.clauseIds.indexOf('PAYMENT_V1') !== -1 && new Set(ev.clauseIds).size === ev.clauseIds.length, JSON.stringify(ev.clauseIds));
    // missing number: refused, nothing minted
    db = world({ docClauseSetV1: true }, Object.assign({}, terms, { deckingPerSheetCents: null }));
    m = await mint(db, kit.makeStorage({ [DEAL_PATH]: PAGE }));
    ok('mint, flag on, decking price unset: refused with the field name, no token', !!m.err && m.err.code === 'failed-precondition' && /Set deckingPerSheetCents in Company Profile/.test(m.err.message) && db._all('deal_accept_tokens').length === 0, m.err && m.err.message);
    db = world({ docClauseSetV1: true }, {});
    m = await mint(db, kit.makeStorage({ [DEAL_PATH]: PAGE }));
    ok('mint, flag on, a tenant that has set none of its numbers: refused (never NBD\'s numbers)', !!m.err && /Set lateGraceDays in Company Profile/.test(m.err.message), m.err && m.err.message);
    // flag off
    db = world({}); m = await mint(db, kit.makeStorage({ [DEAL_PATH]: PAGE }));
    const tok0 = m.out ? (db._get('deal_accept_tokens/' + m.out.token) || {}) : {};
    const served0 = m.out ? await view(m.L, m.out.token) : { sent: '' };
    ok('flag off: no clause field on the token, no block on the served page', !!m.out && tok0.clauseSetV1 === undefined && !/data-nbd-clause-set/.test(served0.sent) && served0.sent.indexOf('Your roof, three packages.') > 0);
    ok('injectClauseBlock(html, null) is the page itself, byte for byte', DE.injectClauseBlock(PAGE, null) === PAGE && DE.injectClauseBlock(PAGE, '') === PAGE);
    ok('a page with no sign section still gets the block (before the end)', /<div data-x><\/div><\/body>/.test(DE.injectClauseBlock('<html><body>x</body></html>', '<div data-x></div>')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
