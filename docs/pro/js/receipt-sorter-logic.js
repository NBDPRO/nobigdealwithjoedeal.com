/**
 * receipt-sorter-logic.js — pure matching for the receipt sorter (2026-10-18).
 *
 * Given ONE unsorted store receipt (an expense doc: PO/job text, store #, date,
 * items, total) and the company's leads, rank the likely jobs and say WHY in
 * plain language. Nothing here writes anything and nothing here is a verdict:
 *
 *   HIGH       the PO text carries a CRM customer number (NBD-0042), or a name
 *              this company already assigned once (remembered alias).
 *              The ONLY level that may be attached without a tap.
 *   suggested  every other match (name / street / date / items / same-trip
 *              grouping). A person taps Assign. Never auto-saved.
 *
 * Signals actually used (all verifiable in the data today):
 *   NBD-#### in the PO ...... exact        alias ................ exact
 *   full name in the PO ..... 45           last name only ....... 28
 *   first name only ......... 12           business name word ... 30
 *   house # + street ........ 50           street only .......... 30
 *   same store + same day as a receipt already assigned to this job .. 25
 *   purchase date inside the job's scheduled window (±) ............. 12
 *   items look like the job's trade (roofing / siding / gutters) .... 10
 * Left out on purpose (no honest data): distance from the store to the job,
 * amount vs estimate materials (no materials total on the lead yet), call and
 * visit notes. A bare date or dollar amount can never match a job alone.
 *
 * Exposes window.NBDReceiptSorterLogic.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;

  const CODE_RE = /\b([A-Z]{2,5}-\d{3,5}(?:-[A-Z0-9]{4})?)\b/i;
  const STREET_NOISE = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'blvd', 'way', 'cir', 'circle', 'pl', 'place', 'trl', 'trace', 'pkwy', 'hwy', 'the', 'and', 'of', 'us']);
  const SHOP_RE = /\b(shop|stock|inventory|tools?|office|truck|van|misc|etc|overhead|personal)\b/i;
  const NICK = {
    john: 'john', jon: 'john', johnny: 'john', jack: 'john', robert: 'robert', rob: 'robert', bob: 'robert', bobby: 'robert',
    william: 'william', bill: 'william', will: 'william', billy: 'william', michael: 'michael', mike: 'michael', mick: 'michael',
    david: 'david', dave: 'david', james: 'james', jim: 'james', jimmy: 'james', thomas: 'thomas', tom: 'thomas', tommy: 'thomas',
    christopher: 'christopher', chris: 'christopher', joseph: 'joseph', joe: 'joseph', richard: 'richard', rick: 'richard', rich: 'richard', dick: 'richard',
    steven: 'steven', steve: 'steven', stephen: 'steven', anthony: 'anthony', tony: 'anthony', matthew: 'matthew', matt: 'matthew',
    daniel: 'daniel', dan: 'daniel', danny: 'daniel', patrick: 'patrick', pat: 'patrick', katherine: 'katherine', kate: 'katherine', katie: 'katherine',
    elizabeth: 'elizabeth', liz: 'elizabeth', beth: 'elizabeth', benjamin: 'benjamin', ben: 'benjamin', samuel: 'samuel', sam: 'samuel',
    nicholas: 'nicholas', nick: 'nicholas', edward: 'edward', ed: 'edward', eddie: 'edward', andrew: 'andrew', andy: 'andrew', drew: 'andrew',
    jennifer: 'jennifer', jen: 'jennifer', jenny: 'jennifer', margaret: 'margaret', peggy: 'margaret', maggie: 'margaret',
    larry: 'lawrence', lawrence: 'lawrence', gregory: 'gregory', greg: 'gregory', jeffrey: 'jeffrey', jeff: 'jeffrey', timothy: 'timothy', tim: 'timothy',
  };
  const BIZ_NOISE = new Set(['llc', 'inc', 'corp', 'co', 'company', 'holdings', 'properties', 'ltd', 'trust', 'group', 'the', 'and', 'church', 'homes', 'home']);

  const TRADES = {
    roofing: /\b(?:shingle|underlayment|ridge|drip edge|flashing|starter|roof|felt|ice (?:&|and)? ?water|coil nail|vent|pipe boot|synthetic)\w*/i,
    siding: /\b(?:siding|j-?channel|soffit|fascia|corner post|starter strip|vinyl|trim coil|caulk|house wrap|hardie|lap)\w*/i,
    gutters: /\b(?:gutter|downspout|elbow|hanger|end cap|miter|drop outlet|splash block|leaf)\w*/i,
  };

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function canon(tok) { return NICK[tok] || tok; }

  // (one edit, or one adjacent swap: Meuller / Mueller)
  function lev1(a, b) {
    if (a === b) return true;
    if (a.length === b.length) {
      for (let k = 0; k < a.length - 1; k++) {
        if (a[k] !== b[k]) {
          if (a[k] === b[k + 1] && a[k + 1] === b[k] && a.slice(k + 2) === b.slice(k + 2)) return true;
          break;
        }
      }
    }
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev1(a, b));

  // → { raw, code, tokens[], houseNo, streetWords[], shop }
  function parsePo(po) {
    const raw = String(po || '').trim();
    const m = CODE_RE.exec(raw);
    const rest = norm(m ? raw.replace(m[0], ' ') : raw);
    const toks = rest ? rest.split(' ') : [];
    const houseNo = (toks.find((t) => /^\d{1,6}$/.test(t)) || '');
    const words = toks.filter((t) => !/^\d+$/.test(t));
    const streetWords = words.filter((t) => t.length >= 3 && !STREET_NOISE.has(t));
    return { raw, code: m ? m[1].toUpperCase() : '', tokens: words, houseNo, streetWords, shop: SHOP_RE.test(raw) };
  }

  function leadParts(lead) {
    const l = lead || {};
    let first = norm(l.firstName), last = norm(l.lastName);
    if (!first && !last && l.name) { const p = norm(l.name).split(' '); first = p[0] || ''; last = p.length > 1 ? p[p.length - 1] : ''; }
    const full = norm(l.name || ((l.firstName || '') + ' ' + (l.lastName || '')));
    const biz = full.split(' ').filter((w) => w.length >= 4 && !BIZ_NOISE.has(w));
    const isBiz = /\b(llc|inc|corp|holdings|properties|ltd|trust|church)\b/i.test(full);
    const street = norm(String(l.address || '').split(',')[0]).split(' ');
    const no = (street.find((t) => /^\d{1,6}$/.test(t)) || '');
    const words = street.filter((t) => !/^\d+$/.test(t) && t.length >= 3 && !STREET_NOISE.has(t));
    return { first, last, biz, isBiz, no, words };
  }

  function dayMs(v) {
    if (!v) return NaN;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    const t = Date.parse(String(v).length === 10 ? v + 'T12:00:00' : v);
    return t;
  }
  const DAY = 86400000;

  function windowOf(lead) {
    const s = dayMs(lead && (lead.scheduledDate || lead.scheduledStart));
    if (!isFinite(s)) return null;
    let e = dayMs(lead.scheduledEndDate);
    if (!isFinite(e)) e = s;
    return { start: s, end: Math.max(s, e) };
  }

  function itemTrade(items) {
    const out = {};
    (items || []).forEach((i) => {
      Object.keys(TRADES).forEach((k) => { if (TRADES[k].test(String(i.desc || ''))) (out[k] = out[k] || []).push(String(i.desc)); });
    });
    return out;
  }
  function leadTrade(lead) {
    const t = norm([lead && lead.damageType, lead && lead.damage_type, lead && lead.subType, lead && lead.serviceType, lead && lead.workType].filter(Boolean).join(' '));
    return ['roofing', 'siding', 'gutters'].filter((k) => (k === 'roofing' ? /roof/.test(t) : k === 'siding' ? /siding/.test(t) : /gutter/.test(t)));
  }

  function shortList(arr) { return arr.slice(0, 2).map((s) => s.replace(/\s+/g, ' ').slice(0, 36)).join(', '); }
  function dayWord(n) { return n === 0 ? 'the same day' : (Math.abs(n) === 1 ? '1 day' : Math.abs(n) + ' days'); }

  /**
   * score one lead for one receipt → { leadId, score, evidence[], level }
   * ctx: { aliases: {key: leadId}, siblings: { 'store|date': { leadId: count } } }
   */
  function scoreLead(receipt, lead, ctx) {
    const c = ctx || {};
    const po = parsePo(receipt.poJobName);
    const ev = [];
    let score = 0;
    const id = lead.id;
    // exact lanes first
    if (po.code && String(lead.customerId || '').toUpperCase() === po.code) {
      return { leadId: id, score: 100, level: 'high', evidence: ['The PO/Job name has this customer\'s number (' + po.code + ')'] };
    }
    const aliasKey = norm(receipt.poJobName);
    if (aliasKey && c.aliases && c.aliases[aliasKey] === id) {
      return { leadId: id, score: 100, level: 'high', evidence: ['You already assigned "' + String(receipt.poJobName).slice(0, 40) + '" to this job before'] };
    }
    const p = leadParts(lead);
    const tok = po.tokens.map(canon);
    const has = (w) => w && tok.some((t) => sameWord(t, canon(w)));
    const firstHit = p.first && has(p.first), lastHit = p.last && p.last.length >= 3 && has(p.last);
    if (firstHit && lastHit) { score += 45; ev.push('The PO name matches the full name'); }
    else if (lastHit && p.last.length >= 4) { score += 28; ev.push('The PO name matches the last name'); }
    else if (firstHit && p.first.length >= 3) { score += 12; ev.push('The PO name matches the first name only (weak)'); }
    else if (p.isBiz && p.biz.some((w) => has(w))) { score += 30; ev.push('The PO name matches the business name'); }
    const streetHit = p.words.length && po.streetWords.some((w) => p.words.some((x) => sameWord(w, x)));
    if (streetHit && po.houseNo && p.no && po.houseNo === p.no) { score += 50; ev.push('House number and street match (' + p.no + ')'); }
    else if (streetHit) { score += 30; ev.push('The street name matches'); }
    // same trip: another receipt from this store on this day already went to this job
    const dkey = String(receipt.storeNumber || '') + '|' + String(receipt.dateKey || '');
    const sib = c.siblings && c.siblings[dkey] && c.siblings[dkey][id];
    if (sib) { score += 25; ev.push(sib + ' other receipt' + (sib === 1 ? '' : 's') + ' from this store on this day already went to this job'); }
    // job window (evidence only: never the reason on its own)
    const w = windowOf(lead), rd = dayMs(receipt.dateKey);
    if (score > 0 && w && isFinite(rd)) {
      if (rd >= w.start - 7 * DAY && rd <= w.end + 3 * DAY) {
        score += 12;
        const d = Math.round((rd - w.start) / DAY);
        ev.push(rd >= w.start && rd <= w.end ? 'Bought while the job was scheduled' : 'Bought ' + dayWord(d) + (d < 0 ? ' before' : ' after') + ' the job\'s scheduled date');
      }
    }
    // items vs the job's trade
    if (score > 0) {
      const it = itemTrade(receipt.items), lt = leadTrade(lead);
      const hit = lt.find((k) => it[k]);
      if (hit) { score += 10; ev.push('Items look like ' + hit + ' (' + shortList(it[hit]) + ')'); }
    }
    return { leadId: id, score: Math.min(99, score), level: 'suggested', evidence: ev };
  }

  /**
   * rank(receipt, leads, ctx) → { candidates[<=3], overhead: {hint, why}, high: candidate|null, closeCall }
   * `receipt` needs: poJobName, storeNumber, dateKey ('YYYY-MM-DD'), items[], category.
   */
  function rank(receipt, leads, ctx) {
    const live = (leads || []).filter((l) => l && l.id && !l.deleted);
    const scored = live.map((l) => scoreLead(receipt, l, ctx)).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    const high = scored.find((s) => s.level === 'high') || null;
    const top = scored.slice(0, 3);
    const po = parsePo(receipt.poJobName);
    const overheadWhy = po.shop ? 'The PO name is a shop word' : (receipt.category === 'tools_small_equipment' ? 'This looks like a tool purchase' : '');
    return {
      candidates: top,
      high: high && (scored.filter((s) => s.level === 'high').length === 1) ? high : null,
      overhead: { hint: !!overheadWhy, why: overheadWhy },
      closeCall: top.length > 1 && top[0].level !== 'high' && top[0].score - top[1].score < 6,
    };
  }

  // Receipts already assigned → 'store|date' → { leadId: count }, so a trip's
  // other receipts can pull the rest of the trip toward the same job.
  function buildSiblings(expenses) {
    const out = {};
    (expenses || []).forEach((e) => {
      if (!e || !e.leadId || e.reviewState === 'unsorted') return;
      const k = String(e.storeNumber || '') + '|' + String(e.dateKey || '');
      (out[k] = out[k] || {})[e.leadId] = ((out[k] || {})[e.leadId] || 0) + 1;
    });
    return out;
  }

  // Which expenses belong in the queue.
  function needsSorting(e) {
    if (!e || e.deleted === true) return false;
    if (e.reviewState === 'unsorted' || e.reviewState === 'suggested') return true;
    if (e.reviewState) return false;
    // imports saved before reviewState existed
    return /^import_/.test(String(e.source || '')) && !e.leadId && e.costType === 'direct';
  }

  root.NBDReceiptSorterLogic = { parsePo, scoreLead, rank, buildSiblings, needsSorting, norm, windowOf, itemTrade };
})();
