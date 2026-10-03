/**
 * health-digest.js — daily production health digest, emailed to the
 * platform owner. Closes the audit's "no production health monitoring"
 * gap with the simplest possible aggregator: scan recent collections,
 * summarize, drop in email_queue.
 *
 * Signals captured (per UTC day):
 *   - Total Vision spend (sum of userCostMeter writes in the period)
 *   - Top 5 leads by Vision cost burn
 *   - Anthropic token usage (sum across api_usage_daily uid+co buckets)
 *   - Stripe webhook activity (event count + any handlers we know fail)
 *   - photo upload counts (rough volume proxy)
 *   - customerAuditEvents volume (homeowner engagement proxy)
 *
 * Scheduled daily at 14:00 UTC (= 9am Eastern). Drops a single row
 * into email_queue/ which the existing emailQueueWorker drains.
 *
 * Disabled by default. Flip on by:
 *   firebase functions:config:set health.digest_enabled="true"  (legacy)
 *   OR set HEALTH_DIGEST_ENABLED=true env var in the deploy.
 */

'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore, FieldPath } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { gateStatus } = require('./cron-gates');

// Destination — single recipient, the platform owner. Could become a
// multi-recipient allowlist if we ever onboard ops staff.
const RECIPIENT = 'jd@nobigdealwithjoedeal.com';

// Aggregate window: previous 24h ending at the function's invocation time.
const WINDOW_MS = 24 * 60 * 60 * 1000;

function fmtUsd(n) {
  return '$' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

async function gatherVisionSpend(db, cutoffMs) {
  // userCostMeter is keyed by `${uid}__${YYYY-MM}` — pull all for
  // current + previous month and sum updates whose `updatedAt` falls
  // inside the window.
  const now = new Date();
  const monthKeys = [
    now.toISOString().slice(0, 7),
    new Date(now.getTime() - 32 * 86_400_000).toISOString().slice(0, 7),
  ];
  let userTotal = 0;
  let userCount = 0;
  for (const mk of monthKeys) {
    const snap = await db.collection('userCostMeter')
      .where('monthKey', '==', mk)
      .get();
    snap.forEach(d => {
      const data = d.data();
      const ts = data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : 0;
      if (ts >= cutoffMs) {
        userTotal += Number(data.visionUsd || 0);
        userCount += Number(data.visionCount || 0);
      }
    });
  }

  // Top 5 leads by spend (lifetime — close enough for a daily digest;
  // adding a 24h-window meter is a follow-up).
  const topLeads = [];
  const leadSnap = await db.collection('leadCostMeter')
    .orderBy('visionUsd', 'desc')
    .limit(5)
    .get();
  leadSnap.forEach(d => {
    const data = d.data();
    topLeads.push({
      leadId: d.id,
      usd: Number(data.visionUsd || 0),
      count: Number(data.visionCount || 0),
    });
  });

  return { userTotal, userCount, topLeads };
}

async function gatherStripe(db, cutoffMs) {
  // stripe_events is admin-SDK only — counts as a rough proxy for
  // webhook health. Empty = either no Stripe activity (fine) or webhook
  // not delivering (bad). We just report the count; a separate
  // failed-events read would need Stripe API access.
  //
  // Filter at the Firestore level (like gatherVisionSpend's monthKey where
  // and gatherActivity's uploadedAt/createdAt where clauses do), not with an
  // unbounded, unordered .limit(200) fetched first and filtered in JS after.
  // stripe_events is an append-only, ever-growing collection (one doc per
  // Stripe event ever processed, no orderBy) — a plain .limit(200) has no
  // guarantee of returning the newest 200 once the collection outgrows 200
  // total events, so the old shape could report "0 events in 24h" forever
  // even with webhooks actively arriving.
  let total = 0;
  let recentTypes = {};
  const snap = await db.collection('stripe_events')
    .where('processedAt', '>=', Timestamp.fromMillis(cutoffMs))
    .limit(2000)
    .get();
  snap.forEach(d => {
    const data = d.data();
    total++;
    recentTypes[data.type] = (recentTypes[data.type] || 0) + 1;
  });
  return { total, recentTypes };
}

async function gatherApiUsage(db) {
  // api_usage_daily/{dayKey}__uid__{uid} and __co__{companyId} —
  // reserved Claude tokens for today. Sum the uid rows (the co rows
  // double-count).
  //
  // `tokens` is the field the claudeProxy budget counter actually writes
  // (functions/handlers/_shared.js reserveClaudeBudget/adjustClaudeBudget,
  // via FieldValue.increment) — there is no `tokensUsed` field anywhere in
  // this codebase, so reading it always summed to 0. `voice_analysisTokens`
  // is the sibling field the voice-intelligence integration writes on the
  // same doc (functions/integrations/voice-intelligence.js
  // incrementVoiceUsage) — also real Claude/Anthropic spend (callClaudeJson
  // hits api.anthropic.com), just under a different key because it shares
  // the counter doc with a non-Claude voice_audioSec field.
  const dayKey = new Date().toISOString().slice(0, 10);
  let total = 0;
  let topUsers = [];
  // Read ONLY today's uid rows: a document-id range on the
  // "{YYYY-MM-DD}__uid__" prefix (2026-10-03). This used to .get() the whole
  // collection — every day's uid AND co rows since launch, growing forever —
  // and filter to today in memory. The id format is the writers' own
  // (handlers/ai.js, integrations/voice-intelligence.js: UTC
  // toISOString().slice(0, 10) + '__uid__' + uid). A __name__ range needs no
  // composite index. The in-loop checks below stay as a belt-and-braces guard.
  const idPrefix = dayKey + '__uid__';
  const snap = await db.collection('api_usage_daily')
    .where(FieldPath.documentId(), '>=', idPrefix)
    .where(FieldPath.documentId(), '<', idPrefix + '')
    .get();
  snap.forEach(d => {
    if (!d.id.includes('__uid__')) return;
    if (!d.id.startsWith(dayKey)) return;
    const data = d.data() || {};
    const tokens = Number(data.tokens || 0) + Number(data.voice_analysisTokens || 0);
    total += tokens;
    topUsers.push({ uid: d.id.split('__uid__')[1], tokens });
  });
  topUsers.sort((a, b) => b.tokens - a.tokens);
  return { total, topUsers: topUsers.slice(0, 5) };
}

async function gatherActivity(db, cutoffMs) {
  // Rough activity proxies. We deliberately use `count()` aggregation
  // where supported but fall through to a bounded fetch elsewhere.
  let photos = 0;
  let portalEvents = 0;
  try {
    const photosSnap = await db.collection('photos')
      .where('uploadedAt', '>=', Timestamp.fromMillis(cutoffMs))
      .limit(2000)
      .get();
    photos = photosSnap.size;
  } catch (_) { /* missing index → skip */ }
  try {
    const eventsSnap = await db.collection('customerAuditEvents')
      .where('createdAt', '>=', Timestamp.fromMillis(cutoffMs))
      .limit(2000)
      .get();
    portalEvents = eventsSnap.size;
  } catch (_) { /* missing index → skip */ }
  return { photos, portalEvents };
}

async function gatherImagePipeline(db, cutoffMs) {
  // metrics/imagePipeline holds LIFETIME counters (FieldValue.increment,
  // never reset) written by functions/image-pipeline.js when a variant
  // set has no doc to land on. `noDocMatched` + `lastGenuineNoMatchAt/
  // Path` are the genuine-orphan signal; `noDocMatchedD2d` is
  // docless-by-design noise (pre-photoPaths knocks) shown for context
  // only. Because the counters never reset, "is it climbing" is judged
  // by lastGenuineNoMatchAt falling inside the digest window — no
  // baseline snapshot needed. The doc does not exist until the first
  // no-match ever fires; absence is healthy zeros, not an error.
  const snap = await db.doc('metrics/imagePipeline').get();
  const empty = { noDocMatched: 0, noDocMatchedD2d: 0, genuineRecent: false, lastGenuinePath: '', lastGenuineAtIso: '' };
  if (!snap.exists) return empty;
  const m = snap.data() || {};
  const at = m.lastGenuineNoMatchAt && typeof m.lastGenuineNoMatchAt.toDate === 'function'
    ? m.lastGenuineNoMatchAt.toDate() : null;
  return {
    noDocMatched: m.noDocMatched || 0,
    noDocMatchedD2d: m.noDocMatchedD2d || 0,
    genuineRecent: !!(at && at.getTime() >= cutoffMs),
    lastGenuinePath: m.lastGenuineNoMatchPath || '',
    lastGenuineAtIso: at ? at.toISOString() : '',
  };
}

// metrics/renderPdf holds LIFETIME ok/fail counters plus the last success and
// failure timestamps, written by functions/render-pdf.js on both outcomes.
//
// The verdict deliberately hangs on a MISSING SUCCESS rather than a rising
// failure count. @sparticuz/chromium 149 dropped its CommonJS build in June;
// require() started returning the ESM namespace, `chromium.executablePath`
// read undefined, and every server-rendered document — warranty, estimate,
// invoice, contract, change order, receipt, inspection, photo report — failed
// at stage:launch and fell back to client-side html2canvas. That ran for
// eleven weeks and nobody noticed, because a silent fallback looks like
// working software from the outside. A failure-count threshold would have been
// slow to trip on this path's low volume (22 calls in three weeks); "renders
// were attempted and not one succeeded" trips on the first digest.
//
// The doc does not exist until the first render is ever attempted; absence is
// healthy silence, not an error.
async function gatherRenderPdf(db, cutoffMs) {
  const idle = {
    attempted: false, okCount: 0, failCount: 0,
    failRecent: false, okRecent: false, neverOk: false,
    lastFailStage: '', lastFailErr: '', lastFailAtIso: '', lastOkAtIso: '',
  };
  const snap = await db.doc('metrics/renderPdf').get();
  if (!snap.exists) return idle;
  const m = snap.data() || {};
  const toDate = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : null);
  const lastFail = toDate(m.lastFailAt);
  const lastOk = toDate(m.lastOkAt);
  const okCount = m.okCount || 0;
  const failCount = m.failCount || 0;
  return {
    attempted: !!(okCount || failCount),
    okCount,
    failCount,
    failRecent: !!(lastFail && lastFail.getTime() >= cutoffMs),
    okRecent: !!(lastOk && lastOk.getTime() >= cutoffMs),
    // The strongest form of the signal: renders have been attempted and not
    // one has ever succeeded. That was true for the whole eleven weeks.
    neverOk: failCount > 0 && okCount === 0,
    lastFailStage: m.lastFailStage || '',
    lastFailErr: m.lastFailErr || '',
    lastFailAtIso: lastFail ? lastFail.toISOString() : '',
    lastOkAtIso: lastOk ? lastOk.toISOString() : '',
  };
}

// True when the PDF renderer needs looking at: something tried to render and
// nothing succeeded in the window. Shared by the subject line and the body so
// they can never disagree about whether today is a bad day.
function renderPdfBroken(r) {
  return !!(r && r.failRecent && !r.okRecent);
}

// Minimal HTML escaper for values that reach the email body. Storage
// object names are client-influenced (the filename segment), so they
// must not be interpolated raw into HTML.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The renderPdf block. Loud when renders are failing, because the failure is
// invisible to everyone else: the client silently falls back to html2canvas,
// so customers still get *a* document and nothing looks broken.
function renderPdfSection(r) {
  const rp = r || {};
  if (!rp.attempted) {
    return '<div style="font-size:13px;margin-bottom:8px;color:#888;">No PDF renders attempted yet — nothing to report.</div>';
  }
  const lifetime = 'Lifetime: <strong>' + fmtNum(rp.okCount) + '</strong> ok · <strong>' + fmtNum(rp.failCount) + '</strong> failed.';
  if (renderPdfBroken(rp)) {
    return '<div style="font-size:13px;margin-bottom:8px;color:#c0392b;">'
      + '<strong>⚠ Every PDF render failed in the last 24h</strong> — no success recorded in the window'
      + (rp.neverOk ? ', and <strong>none on record at all</strong>' : '')
      + '. Failing at stage <code style="font-size:11px;">' + escHtml(rp.lastFailStage) + '</code>'
      + (rp.lastFailErr ? ': <code style="font-size:11px;">' + escHtml(rp.lastFailErr) + '</code>' : '')
      + ' (last ' + escHtml(rp.lastFailAtIso) + '). '
      + 'Documents are silently falling back to the client-side html2canvas path, so this does <em>not</em> surface as a customer-visible error. '
      + lifetime + '</div>';
  }
  if (rp.failRecent) {
    return '<div style="font-size:13px;margin-bottom:8px;color:#b8860b;">'
      + '<strong>Some PDF renders failed in the last 24h</strong>, but renders are still succeeding. '
      + 'Last failure at stage <code style="font-size:11px;">' + escHtml(rp.lastFailStage) + '</code> (' + escHtml(rp.lastFailAtIso) + '). '
      + lifetime + '</div>';
  }
  return '<div style="font-size:13px;margin-bottom:8px;">No PDF render failures in the last 24h.'
    + (rp.lastOkAtIso ? ' Last success ' + escHtml(rp.lastOkAtIso) + '.' : '')
    + ' ' + lifetime + '</div>';
}

function renderCronGatesSection() {
  const rows = gateStatus(process.env).map((g) =>
    '<tr><td style="padding:4px 12px;font-family:monospace;font-size:11px;">' + escHtml(g.name) + '</td>' +
    '<td style="padding:4px 12px;font-family:monospace;font-size:11px;color:#666;">' + escHtml(g.file) + '</td>' +
    '<td style="padding:4px 12px;text-align:right;color:' + (g.on ? '#2e7d32' : '#999') + ';">' + (g.on ? 'ON' : 'off') + '</td></tr>'
  ).join('');
  return '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;"><thead><tr style="text-align:left;color:#888;text-transform:uppercase;letter-spacing:.06em;font-size:10px;"><th style="padding:6px 12px;">Gate</th><th style="padding:6px 12px;">Function</th><th style="padding:6px 12px;text-align:right;">State</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function buildEmailBody({ vision, stripe, api, activity, imagePipe, renderPdf, periodLabel }) {
  const topLeadsRows = vision.topLeads.length
    ? vision.topLeads.map(l =>
        '<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;">' + l.leadId.slice(0, 14) + '…</td>' +
        '<td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">' + fmtUsd(l.usd) + '</td>' +
        '<td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;color:#666;">' + fmtNum(l.count) + ' calls</td></tr>'
      ).join('')
    : '<tr><td colspan="3" style="padding:12px;color:#999;font-style:italic;">No Vision spend yet.</td></tr>';

  const stripeTypeRows = Object.keys(stripe.recentTypes).length
    ? Object.entries(stripe.recentTypes).map(([type, count]) =>
        '<tr><td style="padding:4px 12px;font-family:monospace;font-size:11px;">' + type + '</td>' +
        '<td style="padding:4px 12px;text-align:right;">' + fmtNum(count) + '</td></tr>'
      ).join('')
    : '<tr><td colspan="2" style="padding:8px 12px;color:#999;font-style:italic;">No Stripe events in window.</td></tr>';

  const topUserRows = api.topUsers.length
    ? api.topUsers.map(u =>
        '<tr><td style="padding:4px 12px;font-family:monospace;font-size:11px;">' + u.uid.slice(0, 14) + '…</td>' +
        '<td style="padding:4px 12px;text-align:right;">' + fmtNum(u.tokens) + ' tokens</td></tr>'
      ).join('')
    : '<tr><td colspan="2" style="padding:8px 12px;color:#999;font-style:italic;">No Claude usage today.</td></tr>';

  return [
    '<div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;color:#1a1612;">',
    '<h2 style="font-size:18px;margin:0 0 4px;letter-spacing:.04em;text-transform:uppercase;color:#bd5728;">NBD Pro · Health Digest</h2>',
    '<div style="color:#888;font-size:12px;margin-bottom:18px;">' + periodLabel + '</div>',

    '<h3 style="font-size:14px;color:#1a1612;margin:18px 0 8px;border-bottom:2px solid #bd5728;padding-bottom:4px;">Cron Gates</h3>',
    renderCronGatesSection(),

    '<h3 style="font-size:14px;color:#1a1612;margin:18px 0 8px;border-bottom:2px solid #bd5728;padding-bottom:4px;">Vision AI Spend</h3>',
    '<div style="font-size:13px;margin-bottom:8px;"><strong>' + fmtUsd(vision.userTotal) + '</strong> across <strong>' + fmtNum(vision.userCount) + '</strong> Vision calls in the last 24h.</div>',
    '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;"><thead><tr style="text-align:left;color:#888;text-transform:uppercase;letter-spacing:.06em;font-size:10px;"><th style="padding:6px 12px;">Top Leads (lifetime)</th><th style="padding:6px 12px;text-align:right;">Spend</th><th style="padding:6px 12px;text-align:right;">Calls</th></tr></thead><tbody>' + topLeadsRows + '</tbody></table>',

    '<h3 style="font-size:14px;color:#1a1612;margin:18px 0 8px;border-bottom:2px solid #bd5728;padding-bottom:4px;">Stripe Webhook Activity</h3>',
    '<div style="font-size:13px;margin-bottom:8px;"><strong>' + fmtNum(stripe.total) + '</strong> events processed in the last 24h.</div>',
    '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;"><tbody>' + stripeTypeRows + '</tbody></table>',

    '<h3 style="font-size:14px;color:#1a1612;margin:18px 0 8px;border-bottom:2px solid #bd5728;padding-bottom:4px;">Anthropic Token Usage (today)</h3>',
    '<div style="font-size:13px;margin-bottom:8px;"><strong>' + fmtNum(api.total) + '</strong> tokens reserved across all users.</div>',
    '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;"><tbody>' + topUserRows + '</tbody></table>',

    '<h3 style="font-size:14px;color:#1a1612;margin:18px 0 8px;border-bottom:2px solid #bd5728;padding-bottom:4px;">Activity</h3>',
    '<div style="font-size:13px;line-height:1.6;">',
    '<strong>' + fmtNum(activity.photos) + '</strong> photo uploads · ',
    '<strong>' + fmtNum(activity.portalEvents) + '</strong> homeowner portal events',
    '</div>',

    '<h3 style="font-size:14px;color:#1a1612;margin:18px 0 8px;border-bottom:2px solid #bd5728;padding-bottom:4px;">Image Pipeline</h3>',
    imagePipe.genuineRecent
      ? '<div style="font-size:13px;margin-bottom:8px;color:#c0392b;"><strong>⚠ Orphaned variants in the last 24h</strong> — a photo got WebP variants but no /photos doc matched its storagePath (last: <code style="font-size:11px;">' + escHtml(imagePipe.lastGenuinePath) + '</code> at ' + escHtml(imagePipe.lastGenuineAtIso) + '). Lifetime genuine orphans: <strong>' + fmtNum(imagePipe.noDocMatched) + '</strong>. Sweep with <code>scripts/backfill-photos-variants.js</code>.</div>'
      : '<div style="font-size:13px;margin-bottom:8px;">No orphaned variants in the last 24h. Lifetime: <strong>' + fmtNum(imagePipe.noDocMatched) + '</strong> genuine · <strong>' + fmtNum(imagePipe.noDocMatchedD2d) + '</strong> d2d docless-by-design.</div>',

    '<h3 style="font-size:14px;color:#1a1612;margin:18px 0 8px;border-bottom:2px solid #bd5728;padding-bottom:4px;">Server PDF Renderer</h3>',
    renderPdfSection(renderPdf),

    '<div style="margin-top:24px;padding-top:14px;border-top:1px solid #ddd;font-size:11px;color:#888;">Auto-generated daily. Source: <code>functions/health-digest.js</code>. To pause: unset HEALTH_DIGEST_ENABLED in the function env.</div>',
    '</div>'
  ].join('\n');
}

exports.healthDigestCron = onSchedule(
  {
    // Daily 14:00 UTC = ~9-10am Eastern (whichever side of DST).
    schedule: '0 14 * * *',
    timeZone: 'Etc/UTC',
    maxInstances: 1,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const enabled = process.env.HEALTH_DIGEST_ENABLED === 'true';
    if (!enabled) {
      logger.info('health_digest.skipped', { reason: 'HEALTH_DIGEST_ENABLED not set to true' });
      return;
    }

    const db = getFirestore();
    const now = Date.now();
    const cutoffMs = now - WINDOW_MS;
    const cutoff = new Date(cutoffMs);

    const [vision, stripe, api, activity, imagePipe, renderPdf] = await Promise.all([
      gatherVisionSpend(db, cutoffMs).catch(e => { logger.warn('health_digest.vision_failed', e.message); return { userTotal: 0, userCount: 0, topLeads: [] }; }),
      gatherStripe(db, cutoffMs).catch(e => { logger.warn('health_digest.stripe_failed', e.message); return { total: 0, recentTypes: {} }; }),
      gatherApiUsage(db).catch(e => { logger.warn('health_digest.api_failed', e.message); return { total: 0, topUsers: [] }; }),
      gatherActivity(db, cutoffMs).catch(e => { logger.warn('health_digest.activity_failed', e.message); return { photos: 0, portalEvents: 0 }; }),
      gatherImagePipeline(db, cutoffMs).catch(e => { logger.warn('health_digest.image_pipeline_failed', e.message); return { noDocMatched: 0, noDocMatchedD2d: 0, genuineRecent: false, lastGenuinePath: '', lastGenuineAtIso: '' }; }),
      // Failing closed to "attempted:false" here means a read error reads as
      // silence, not as a false alarm — same convention as the gathers above.
      gatherRenderPdf(db, cutoffMs).catch(e => { logger.warn('health_digest.render_pdf_failed', e.message); return { attempted: false, okCount: 0, failCount: 0, failRecent: false, okRecent: false, neverOk: false, lastFailStage: '', lastFailErr: '', lastFailAtIso: '', lastOkAtIso: '' }; }),
    ]);

    const periodLabel = cutoff.toUTCString() + ' → ' + new Date(now).toUTCString();
    const bodyHtml = buildEmailBody({ vision, stripe, api, activity, imagePipe, renderPdf, periodLabel });
    const subject = 'NBD Pro · Health Digest · ' + fmtUsd(vision.userTotal) + ' Vision · ' + fmtNum(activity.photos) + ' photos'
      + (imagePipe.genuineRecent ? ' · ⚠ pipeline orphan' : '')
      // In the subject because the body went unread for eleven weeks while this
      // path was 100% down; a warning only inside the email is not a warning.
      + (renderPdfBroken(renderPdf) ? ' · ⚠ PDF renders failing' : '');

    await db.collection('email_queue').add({
      to: RECIPIENT,
      subject,
      bodyHtml,
      bodyPlain: 'Health digest for ' + periodLabel + ' — Vision ' + fmtUsd(vision.userTotal) + ', ' + fmtNum(activity.photos) + ' photo uploads, ' + fmtNum(stripe.total) + ' Stripe events.',
      kind: 'health_digest',
      // The emailQueueWorker query filters on status=='pending'; a doc
      // without it is never claimed, so the digest silently never sends.
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });

    logger.info('health_digest.queued', {
      visionUsd: vision.userTotal,
      stripeEvents: stripe.total,
      photoUploads: activity.photos,
      renderPdfBroken: renderPdfBroken(renderPdf),
      renderPdfOk: renderPdf.okCount,
      renderPdfFail: renderPdf.failCount,
    });
  }
);

exports._test = { buildEmailBody, fmtUsd, fmtNum, escHtml, gatherImagePipeline, gatherRenderPdf, renderPdfBroken, renderPdfSection, renderCronGatesSection };
