/**
 * functions/portal-signed-agreement.js — "Your signed agreement" in the
 * homeowner portal for a job signed in the deal room (homeowner money audit
 * 2026-10-07, M4: "the homeowner gets no copy of what they signed in the deal
 * room"). E-signed contracts already reach the portal's Documents shelf as
 * the executed PDF; a deal-room signature left nothing.
 *
 * Read-only, rebuilt from the acceptance record — never re-priced:
 *   - deal_rooms/{id}: acceptedTier, acceptedPrice (the price they signed;
 *     a later estimate edit never shows here), acceptedAt, acceptedSignature
 *     (the drawn PNG, the same charset submitDealAcceptance accepted),
 *     acceptedEvidence.consent, scheduledInstallDate, scopeSummary;
 *   - the deal page as stored when they accepted (deal_rooms/<uid>/<id>.html,
 *     the page whose digest acceptedEvidence.pageSha256 records) for the
 *     package's description / warranty line and the Notice of Right to Cancel.
 * The legal text comes from the contract renderer itself
 * (ky-insurance-law.js): the FTC 429.1(a) statement printed beside the
 * signature, the two KRS 367.624(3) notices when the page carried them, and
 * the cancel packet rebuilt by restampCancelPacket from the inputs the page
 * stored, dated the day they signed. Nothing rep-written is copied as HTML:
 * text pulled from the page is decoded to plain text and re-escaped.
 *
 * Pure: no Firestore, no Storage, no clock. functions/portal.js does the
 * reads (portal-token auth, tenant filter) and calls these.
 */
'use strict';

const KyLaw = require('./ky-insurance-law');

const DONE = ['accepted', 'signed', 'scheduled'];
const TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
const TIER_LABELS = { economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' };
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const PACKET_RE = /<!--nbd-cancel-packet:start-->[\s\S]*?<!--nbd-cancel-packet:end-->/;
const KY_NOTICE_MARK = 'data-nbd-statutory="ky-367-624-3"';
const AGREEMENT_NAME = 'Your signed agreement';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function _ms(v) {
  if (v == null || v === '') return NaN;
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return NaN; } }
  if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return NaN; } }
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && Number.isFinite(Number(v._seconds))) return Number(v._seconds) * 1000;
  if (typeof v === 'object' && Number.isFinite(Number(v.seconds))) return Number(v.seconds) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

/** When they signed (ms), or NaN. */
function signedAtMs(deal) {
  const d = deal || {};
  const a = _ms(d.acceptedAt);
  if (Number.isFinite(a)) return a;
  const e = d.acceptedEvidence && _ms(d.acceptedEvidence.at);
  return Number.isFinite(e) ? e : NaN;
}

/** A deal room the homeowner signed (a recorded remote acceptance). */
function isSignedDeal(deal) {
  const d = deal || {};
  return DONE.indexOf(d.status) !== -1
    && TIERS.indexOf(d.acceptedTier) !== -1
    && Number(d.acceptedPrice) > 0
    && Number.isFinite(signedAtMs(d));
}

/**
 * The Documents-shelf rows for this lead's signed deal rooms, newest first.
 * @param {{id: string, data: object}[]} rows deal_rooms docs, ALREADY
 *   filtered to this lead and the portal's tenant by the caller.
 */
function agreementsFor(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.id === 'string' && ID_RE.test(r.id) && isSignedDeal(r.data))
    .map((r) => ({
      id: 'agreement-' + r.id,
      dealId: r.id,
      kind: 'agreement',
      name: AGREEMENT_NAME,
      date: new Date(signedAtMs(r.data)).toISOString(),
      url: null,
      viaHtml: true,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Where the deal page they accepted is stored, or null (never outside the deal's own path). */
function dealPagePath(dealId, deal) {
  const d = deal || {};
  if (typeof dealId !== 'string' || !ID_RE.test(dealId)) return null;
  if (typeof d.userId !== 'string' || !UID_RE.test(d.userId)) return null;
  return 'deal_rooms/' + d.userId + '/' + dealId + '.html';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#039': "'", apos: "'", nbsp: ' ', rarr: '→', mdash: '—', ndash: '–' };
/** Rep-written page HTML → plain text (tags dropped, the common entities decoded). */
function textOf(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#?\w+);/g, (m, k) => (Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k]
      : (/^#\d+$/.test(k) ? String.fromCharCode(Number(k.slice(1))) : m)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The accepted package's description + warranty line as the stored page printed them (plain text). */
function tierCardText(pageHtml, tier) {
  const s = String(pageHtml || '');
  const at = s.indexOf('id="tier-' + tier + '"');
  if (at < 0) return { description: '', warranty: '' };
  const next = s.indexOf('id="tier-', at + 10);
  const card = s.slice(at, next > at ? next : at + 6000);
  const pick = (cls) => {
    const m = new RegExp('<div class="' + cls + '">([\\s\\S]*?)</div>').exec(card);
    return m ? textOf(m[1]).replace(/^🛡️\s*/, '').slice(0, 600) : '';
  };
  return { description: pick('tier-desc'), warranty: pick('tier-warranty') };
}

function _packetOpts(block) {
  const m = /data-nbd-cancel-opts="([^"]*)"/.exec(block || '');
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1].replace(/&amp;/g, '&'))); } catch (_) { return null; }
}

function _money(dollars) {
  const c = Math.round(Number(dollars) * 100);
  const n = Number.isFinite(c) ? c : 0;
  return '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

const CSS = '<style>'
  + 'body{margin:0;background:#fff;color:#111;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;}'
  + '.sa{max-width:720px;margin:0 auto;padding:24px 18px 40px;}'
  + '.sa-co{font-weight:700;color:#BD5728;letter-spacing:.02em;}'
  + '.sa h1{font-size:24px;margin:4px 0 4px;}.sa h2{font-size:18px;margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;}'
  + '.sa-sub{color:#555;margin:0 0 6px;}'
  + '.sa-kv{width:100%;border-collapse:collapse;}.sa-kv th,.sa-kv td{text-align:left;vertical-align:top;padding:7px 0;border-bottom:1px solid #eee;}'
  + '.sa-kv th{color:#555;font-weight:600;width:42%;padding-right:12px;}.sa-kv td{font-weight:700;font-variant-numeric:tabular-nums;}'
  + '.sa-scope{margin:6px 0 0;padding-left:20px;}.sa-scope li{margin:3px 0;}'
  + '.sa-sig{border:1px solid #ccc;border-radius:8px;padding:12px;margin:10px 0;background:#fafafa;}'
  + '.sa-sig img{display:block;max-width:100%;height:auto;max-height:160px;background:#fff;border:1px solid #e5e5e5;border-radius:6px;}'
  + '.sa-note{color:#555;font-size:14px;}'
  + '@media print{.sa{padding:0;}.sa h2{break-after:avoid;}}'
  + '</style>';

/**
 * The read-only agreement document (a whole HTML page for the portal's
 * sandboxed viewer), or null when the deal is not a signed one.
 * @param {object} a { dealId, deal, pageHtml (string|null), companyName, timeZone }
 */
function buildSignedAgreementHtml(a) {
  const o = a || {};
  const d = o.deal || {};
  if (!isSignedDeal(d)) return null;
  const tz = _validZone(o.timeZone) ? o.timeZone : KyLaw.DEFAULT_TIME_ZONE;
  const at = signedAtMs(d);
  const when = new Date(at);
  const dayText = when.toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' });
  const timeText = when.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const page = typeof o.pageHtml === 'string' ? o.pageHtml : '';
  const tier = d.acceptedTier;
  const card = tierCardText(page, tier);
  const tierDesc = card.description || (d.tiers && d.tiers[tier] && typeof d.tiers[tier].description === 'string' ? d.tiers[tier].description : '');
  const packetM = page ? PACKET_RE.exec(page) : null;
  const pOpts = packetM ? _packetOpts(packetM[0]) : null;
  // The KRS 367.624(3) notices: printed above the signature on the page they
  // signed (a Kentucky insurance deal). Without the stored page, classify the
  // deal itself — failing closed, as the deal page does.
  const ky = page
    ? (page.indexOf(KY_NOTICE_MARK) !== -1 || !!(pOpts && pOpts.kyInsurance === true))
    : !!KyLaw.classify({ address: d.address, insuranceClaim: d.insuranceClaim === true,
      insuranceCarrier: d.insuranceCarrier, claimNumber: d.claimNumber }).kyInsurance;
  // The Notice of Right to Cancel, rebuilt by the contract renderer from the
  // inputs the page stored, dated the day they signed.
  let packet = '';
  if (packetM && pOpts) {
    try { packet = KyLaw.restampCancelPacket(packetM[0], when); } catch (_) { packet = ''; }
    if (!PACKET_RE.test(packet)) packet = '';
  }
  const scope = (Array.isArray(d.scopeSummary) ? d.scopeSummary : [])
    .map((x) => (typeof x === 'string' ? x : (x && (x.name || x.label)) || ''))
    .map((x) => String(x).trim()).filter(Boolean).slice(0, 60);
  const sig = typeof d.acceptedSignature === 'string' && SIG_RE.test(d.acceptedSignature) && d.acceptedSignature.length <= 600 * 1024
    ? d.acceptedSignature : '';
  const consent = !!(d.acceptedEvidence && d.acceptedEvidence.consent === true);
  const name = String(d.customerName || '').trim();
  const install = typeof d.scheduledInstallDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.scheduledInstallDate)
    ? KyLaw.formatDay(Date.parse(d.scheduledInstallDate + 'T00:00:00Z')) : '';
  const kv = [
    ['Package', TIER_LABELS[tier] || tier],
    ['Price you agreed to', _money(d.acceptedPrice)],
  ];
  if (card.warranty) kv.push(['Warranty', card.warranty]);
  if (install) kv.push(['Install date you asked for', install]);
  kv.push(['Signed', dayText + ', ' + timeText]);
  const co = String(o.companyName || '').trim();

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(AGREEMENT_NAME) + '</title>' + CSS + KyLaw.STATUTORY_CSS + '</head><body>'
    + '<main class="sa" data-signed-agreement data-deal-tier="' + esc(tier) + '">'
    + (co ? '<div class="sa-co">' + esc(co) + '</div>' : '')
    + '<h1>' + esc(AGREEMENT_NAME) + '</h1>'
    + '<p class="sa-sub">A read-only copy of what you agreed to and signed on ' + esc(dayText) + '.</p>'
    + (name ? '<p class="sa-sub">' + esc(name) + (d.address ? ' · ' + esc(d.address) : '') + '</p>'
      : (d.address ? '<p class="sa-sub">' + esc(d.address) + '</p>' : ''))
    + '<h2>What you agreed to</h2>'
    + '<table class="sa-kv">' + kv.map((r) => '<tr><th scope="row">' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>').join('') + '</table>'
    + (tierDesc ? '<p>' + esc(tierDesc) + '</p>' : '')
    + (scope.length ? '<h2>What’s included</h2><ul class="sa-scope">' + scope.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '')
    + (ky ? '<h2>Kentucky notices</h2>' + KyLaw.kyNoticesHtml() : '')
    + '<h2>Your signature</h2>'
    + KyLaw.ftcStatementHtml()
    + '<div class="sa-sig">'
    + (sig ? '<img src="' + esc(sig) + '" alt="' + esc('Signature' + (name ? ' of ' + name : '')) + '">' : '')
    + '<p>Signed electronically' + (name ? ' by <strong>' + esc(name) + '</strong>' : '') + ' on ' + esc(dayText) + ' at ' + esc(timeText) + '.</p>'
    + (consent ? '<p class="sa-note">' + esc('You agreed: ' + DEAL_CONSENT_TEXT) + '</p>' : '')
    + '</div>'
    + (packet || '<p class="sa-note">Your Notice of Right to Cancel is on the agreement your contractor keeps. Ask them for a copy.</p>')
    + '<p class="sa-note">Made from the record kept when you signed. The price is the one you agreed to; it does not change if the estimate is edited later.</p>'
    + '</main></body></html>';
}

// Same words as deal-acceptance.js DEAL_CONSENT_TEXT (the page prints them beside the signature).
const DEAL_CONSENT_TEXT = 'I agree to sign electronically. My electronic signature is the legal equivalent of my handwritten signature.';

module.exports = {
  AGREEMENT_NAME,
  DEAL_CONSENT_TEXT,
  isSignedDeal,
  signedAtMs,
  agreementsFor,
  dealPagePath,
  textOf,
  tierCardText,
  buildSignedAgreementHtml,
};
