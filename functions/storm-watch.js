/**
 * NBD — Storm watcher (direction C) — runs inside stormPoller (storm-poller.js)
 * ═══════════════════════════════════════════════════════════════
 * Every 30 minutes, checks NWS Local Storm Reports (via IEM — the same
 * NOAA-sourced feed /api/storm-report already uses) for NEW qualifying
 * events inside the service area, and:
 *
 *   1. ALWAYS alerts Joe (SMS + email): what fell, where, how big, and how
 *      many storm-alert subscribers sit within texting range — so Joe is
 *      knocking while competitors are reading the weather news.
 *   2. OPTIONALLY texts affected storm_alert_subscribers — the people who
 *      signed up on /storm-alerts under the promise "we'll only text you
 *      when severe weather actually hits your zip code" (express consent).
 *      GATED behind STORM_TEXT_ENABLED === 'true' (default OFF; needs the
 *      Twilio A2P registration live first). When the gate is off, Joe's
 *      alert shows exactly who WOULD have been texted — dry-run visibility,
 *      same philosophy as FUNNEL_RECOVERY_ENABLED.
 *
 * Qualifying event: hail >= 0.75", wind >= 58 mph or wind damage report,
 * or any tornado report, within SERVICE_RADIUS_MI of a service-area city.
 * Dedupe: each LSR is keyed (time+coords+type) into storm_events/{key};
 * an event alerts exactly once, and re-fetch overlap is harmless.
 * Subscriber protections: 15 mi radius zip-centroid match, at most one
 * storm text per subscriber per STORM_TEXT_COOLDOWN_H — the SAME cooldown
 * field + constant checkStormAlerts uses, so one storm cannot text a person
 * from both crons — the TCPA opt-out register (sms_opt_outs), and the cooldown
 * stamp is claimed in a transaction BEFORE the send (storm-sms-guard.js), so
 * a failed stamp can no longer leave a person textable again.
 */

const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Resend } = require('resend');
// Lazy require (2026-08-07) — see lead-alert.js: ~21 MB SDK off the
// cold-start path; call sites use _twilio()(...).
let _twilioSdk = null;
const _twilio = () => (_twilioSdk = _twilioSdk || require('twilio'));
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const StormGuard = require('./storm-sms-guard');
const TextingGate = require('./sms-texting-gate');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');

const ALERT_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];
const JOE_SMS = '+18594207382';

const LOOKBACK_H = 3;            // re-fetch overlap; dedupe absorbs repeats
const SERVICE_RADIUS_MI = 25;    // event must be this close to a service city
const SUBSCRIBER_RADIUS_MI = 15; // "hits your zip" honesty radius
// Cooldown: StormGuard.STORM_TEXT_COOLDOWN_H (shared with checkStormAlerts).
const MIN_HAIL_IN = 0.75;
const MIN_WIND_MPH = 58;

// Service-area city centers (same table as the site's location pages).
const CITY_COORDS = [
  [39.03, -84.22], [39.08, -84.34], [39.08, -84.18], [39.29, -83.99],
  [39.23, -84.38], [39.10, -84.51], [39.40, -83.98], [39.08, -84.51],
  [39.02, -84.60], [39.35, -84.56], [39.19, -83.93], [39.00, -84.63],
  [39.04, -84.55], [39.23, -84.16], [39.18, -84.34], [39.44, -84.21],
  [39.27, -84.26], [39.31, -84.22], [39.36, -84.31], [39.18, -84.29],
  [39.44, -84.36], [39.03, -83.92], [39.55, -84.23], [39.33, -84.40],
  [39.45, -83.83],
];

// Zip -> approximate centroid, for subscriber proximity. Explicit entries
// for the service-area towns; prefix fallbacks (452xx -> Cincinnati,
// 410xx -> Covington) catch the metro spread; unknown zips are never
// texted and are surfaced in Joe's alert instead.
const ZIP_COORDS = {
  '45140': [39.27, -84.26], '45040': [39.36, -84.31], '45036': [39.44, -84.21],
  '45039': [39.31, -84.22], '45050': [39.44, -84.36], '45066': [39.55, -84.23],
  '45069': [39.33, -84.40], '45014': [39.35, -84.56], '45103': [39.08, -84.18],
  '45102': [39.03, -84.22], '45122': [39.23, -84.16], '45150': [39.18, -84.29],
  '45244': [39.08, -84.34], '45255': [39.06, -84.33], '45243': [39.18, -84.34],
  '45242': [39.23, -84.38], '45107': [39.29, -83.99], '45113': [39.40, -83.98],
  '45118': [39.19, -83.93], '45154': [39.03, -83.92], '45177': [39.45, -83.83],
  '41042': [39.00, -84.63], '41011': [39.08, -84.51], '41014': [39.07, -84.52],
  '41017': [39.04, -84.55], '41018': [39.02, -84.60],
};
function zipCoords(zip) {
  const z = String(zip || '').slice(0, 5);
  if (ZIP_COORDS[z]) return ZIP_COORDS[z];
  if (z.startsWith('452')) return [39.10, -84.51]; // Cincinnati metro
  if (z.startsWith('410')) return [39.08, -84.51]; // NKY river cities
  return null;
}

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function normType(t) {
  t = String(t || '').toUpperCase();
  if (t.includes('HAIL')) return 'hail';
  if (t.includes('TORNADO')) return 'tornado';
  if (t.includes('WND') || t.includes('WIND')) return 'wind';
  return null;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function iso(d) { return d.toISOString().slice(0, 16) + 'Z'; }

// Exported for the unit fixture test (tests/smoke covers pure logic only).
function qualifies(kind, mag, typetext) {
  if (kind === 'tornado') return true;
  if (kind === 'hail') return mag != null && mag >= MIN_HAIL_IN;
  if (kind === 'wind') {
    if (mag != null && mag >= MIN_WIND_MPH) return true;
    return /DMG|DAMAGE/i.test(String(typetext || '')); // damage reports carry no magnitude
  }
  return false;
}
function eventKey(p, c) {
  const raw = [p.valid || p.utc_valid || '', c[1], c[0], p.typetext || ''].join('|');
  return raw.replace(/[^\w.\-|]/g, '_').slice(0, 240);
}
function eventLabel(ev) {
  if (ev.kind === 'hail') return `${ev.mag}" hail`;
  if (ev.kind === 'tornado') return 'TORNADO report';
  return ev.mag ? `${ev.mag} mph wind` : 'wind damage';
}

async function fetchRecentLsrs() {
  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_H * 3600_000);
  const url = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=' +
    iso(start) + '&ets=' + iso(now) + '&states=OH,KY,IN';
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('IEM HTTP ' + res.status);
  const j = await res.json();
  return (j && j.features) || [];
}

// The storm-REPORTS half of the merged storm poller (functions/storm-poller.js,
// 2026-10-04). It used to be its own every-30-minutes stormWatch cron next to
// checkStormAlerts; one poller now runs both, back to back, with the same
// guards (storm-sms-guard.js): master switch, opt-out register, quiet hours,
// cooldown claimed before the send, STORM_TEXT_ENABLED for subscriber texts.
async function runStormWatch() {
  const db = getFirestore();
  let feats;
  try { feats = await fetchRecentLsrs(); }
  catch (e) { logger.warn('stormWatch: IEM fetch failed', { err: e.message }); return; }

  // New qualifying events in the service area
  const events = [];
  for (const f of feats) {
    const c = f.geometry && f.geometry.coordinates; const p = f.properties || {};
    if (!c) continue;
    const kind = normType(p.typetext || p.type);
    const mag = (p.magf != null && p.magf !== '') ? Number(p.magf) : null;
    if (!kind || !qualifies(kind, mag, p.typetext)) continue;
    const inArea = CITY_COORDS.some(([la, lo]) => haversineMi(la, lo, c[1], c[0]) <= SERVICE_RADIUS_MI);
    if (!inArea) continue;
    const key = eventKey(p, c);
    const ref = db.collection('storm_events').doc(key);
    if ((await ref.get()).exists) continue; // already handled
    const ev = {
      key, kind, mag, lat: c[1], lon: c[0],
      city: p.city || '', county: p.county || '', st: p.st || p.state || '',
      valid: p.valid || p.utc_valid || '', typetext: p.typetext || '',
    };
    await ref.set({ ...ev, processedAt: FieldValue.serverTimestamp() });
    events.push(ev);
  }
  if (!events.length) { logger.info('stormWatch: no new qualifying events'); return; }

  // Affected subscribers (within radius of ANY new event)
  // TCPA master switch (integrations/stormAlerts.enabled; absent = on) —
  // read every run; Joe's own alert still goes out with texting shown OFF.
  const switchOn = await StormGuard.stormAlertsEnabled(db, logger);
  if (!switchOn) logger.info('stormWatch: storm texts switched off', { switchDoc: StormGuard.STORM_SWITCH_DOC });
  const textEnabled = process.env.STORM_TEXT_ENABLED === 'true' && switchOn;
  const nowMs = Date.now();
  // active:true is server-stamped on every subscriber (functions/handlers/
  // integrations.js's serverDefaults, never client-trusted) specifically so
  // an opted-out subscriber stops matching every alert query — sms-
  // functions.js's sibling checkStormAlerts cron already filters on it.
  // This query queried unfiltered, so an unsubscribed homeowner kept
  // receiving stormWatch's texts even after opting out.
  //
  // 2026-10-03: was .limit(1000) on an unordered query — every subscriber
  // past the first 1000 was silently never texted. Paged by documentId now.
  const subDocs = await StormGuard.loadActiveSubscribers(db, { logger });
  const affected = [];
  let unknownZips = 0;
  for (const doc of subDocs) {
    const s = doc.data() || {};
    const digits = String(s.phone || '').replace(/[^\d]/g, '');
    if (digits.length !== 10 && !(digits.length === 11 && digits[0] === '1')) continue;
    const zc = zipCoords(s.zip);
    if (!zc) { unknownZips++; continue; }
    const near = events.find((ev) => haversineMi(zc[0], zc[1], ev.lat, ev.lon) <= SUBSCRIBER_RADIUS_MI);
    if (!near) continue;
    if (StormGuard.inStormCooldown(s, nowMs)) continue;
    affected.push({ ref: doc.ref, to: '+1' + digits.slice(-10), zip: String(s.zip || ''), tz: s.tz, event: near });
  }

  // 1) Joe's alert — always
  const evLines = events.map((ev) =>
    `${eventLabel(ev)} near ${ev.city || ev.county}, ${ev.st} at ${ev.valid}`);
  // Storm Watch on the D2D map (2026-10-02): the text links straight to the
  // door-knocking map on the first report, with the Storms layer on.
  const mapLink = 'https://nobigdealwithjoedeal.com/pro/dashboard.html?storm=' + events[0].lat.toFixed(3) + ',' + events[0].lon.toFixed(3);
  const smsToJoe =
    `⛈️ NBD Storm Watch — map: ${mapLink} — ${evLines.join(' | ')}. ` +
    `${affected.length} subscriber${affected.length === 1 ? '' : 's'} in range` +
    (textEnabled ? ' — texting them now.' : ' (texting OFF — see email).');
  try {
    const client = _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
    await client.messages.create({ to: JOE_SMS, from: TWILIO_PHONE_NUMBER.value(), body: smsToJoe.slice(0, 480) });
  } catch (e) { logger.error('stormWatch: joe sms failed', { err: e.message }); }
  try {
    const resend = new Resend(RESEND_API_KEY.value());
    const zipCounts = {};
    for (const a of affected) zipCounts[a.zip] = (zipCounts[a.zip] || 0) + 1;
    const html = `<!DOCTYPE html><html><body style="font-family:'Barlow','Segoe UI',Roboto,sans-serif;color:#333">
<h2 style="color:#BD5728">⛈️ Storm Watch — ${events.length} new report${events.length === 1 ? '' : 's'} in the service area</h2>
<ul>${events.map((ev) => `<li><b>${esc(eventLabel(ev))}</b> near ${esc(ev.city || ev.county)}, ${esc(ev.st)} — ${esc(ev.valid)} <span style="color:#6b7280">(${ev.lat.toFixed(2)}, ${ev.lon.toFixed(2)})</span></li>`).join('')}</ul>
<p><b>${affected.length}</b> subscriber${affected.length === 1 ? '' : 's'} within ${SUBSCRIBER_RADIUS_MI} mi${unknownZips ? ` (+${unknownZips} with unmappable zips, not texted)` : ''}: ${esc(Object.entries(zipCounts).map(([z, n]) => `${z}×${n}`).join(', ')) || '—'}</p>
<p>${textEnabled ? 'Subscriber texts are GOING OUT now.' : '<b>Subscriber texting is OFF</b> (STORM_TEXT_ENABLED not set) — this is the list that WOULD have been texted.'}</p>
<p>Go time: <a href="https://nobigdealwithjoedeal.com/storm-check">storm-check</a> traffic usually follows within hours.</p>
</body></html>`;
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'noreply@nobigdealwithjoedeal.com',
      to: ALERT_EMAILS,
      subject: `⛈️ Storm Watch: ${evLines[0]}${events.length > 1 ? ` (+${events.length - 1} more)` : ''}`,
      html,
    });
  } catch (e) { logger.error('stormWatch: joe email failed', { err: e.message }); }

  // 2) Subscriber texts — gated
  // Each text: opt-out register → cooldown claim (transaction, BEFORE the
  // send; a claim failure is logged and nothing is sent) → send.
  let texted = 0;
  const skipped = {};
  if (textEnabled && affected.length) {
    const client = _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
    for (const a of affected) {
      const result = await StormGuard.sendGuardedStormText({
        db,
        subscriberRef: a.ref,
        phone: a.to,
        source: 'stormWatch',
        // Storm subscribers are NBD's own list: NBD's Do Not Text list.
        companyId: TextingGate.NBD_OWNER_UID,
        eventKey: a.event.key,
        logger,
        tz: a.tz,
        serverTimestamp: () => FieldValue.serverTimestamp(),
        send: () => client.messages.create({
          to: a.to,
          from: TWILIO_PHONE_NUMBER.value(),
          body: `NBD Storm Alert: ${eventLabel(a.event)} reported near ${a.event.city || 'your area'}. If your roof took it, Joe documents damage free before you call insurance: nobigdealwithjoedeal.com/storm-check or call/text (859) 420-7382. Reply STOP to opt out.`,
        }),
      });
      if (result.status === 'sent') texted++;
      else skipped[result.status] = (skipped[result.status] || 0) + 1;
    }
  }
  if (skipped.quiet_hours) {
    logger.info('stormWatch: quiet hours skipped', { count: skipped.quiet_hours, window: StormGuard.STORM_QUIET_HOURS });
  }
  logger.info('stormWatch: done', { events: events.length, affected: affected.length, texted, textEnabled, skipped });
}

// Secrets this half reads (storm-poller.js binds the union).
const STORM_WATCH_SECRETS = [RESEND_API_KEY, EMAIL_FROM, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER];
exports.runStormWatch = runStormWatch;
exports.STORM_WATCH_SECRETS = STORM_WATCH_SECRETS;

exports._test = { qualifies, normType, zipCoords, haversineMi, eventKey };
