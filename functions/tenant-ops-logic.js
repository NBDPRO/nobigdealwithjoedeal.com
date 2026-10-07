/**
 * tenant-ops-logic.js — pure helpers for the tenant-ready functions
 * (2026-10-04): the homeowner-email sender identity, the company data export,
 * the admin Tenants rows and the platform onboarding emails. No Firestore,
 * no network — tenant-ops.js wires them up; tests drive them directly.
 */
'use strict';

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const READ_ONLY_GRACE_DAYS = 30;

// ── Homeowner emails show the contractor (item 8) ────────────────────────
// "Joe Deal <jd@x>" | "<jd@x>" | "jd@x" → "jd@x"
function addressOf(from) {
  const s = String(from || '').trim();
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (m) return m[1];
  return /^[^\s<>@]+@[^\s<>@]+$/.test(s) ? s : '';
}
// A display name safe inside a quoted RFC 5322 phrase: no quotes, angle
// brackets, backslashes or line breaks (header injection), 70 chars max.
function safeDisplayName(name) {
  return String(name || '').replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
}
function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v);
}
/**
 * senderFor(tenantKey, profile, baseFrom) → { from, replyTo }
 * NBD (the platform tenant) keeps the platform EMAIL_FROM exactly and no
 * company reply-to — byte-identical to before. Any other company: its brand
 * name as the From DISPLAY name on the platform's verified sending address
 * (custom sending domains are a later step), and its business email as
 * Reply-To so a homeowner's reply reaches the contractor, not NBD.
 */
function senderFor(tenantKey, profile, baseFrom) {
  if (!tenantKey || tenantKey === NBD_OWNER_UID) return { from: baseFrom, replyTo: null };
  const p = profile || {};
  const b = (p.brand && typeof p.brand === 'object') ? p.brand : {};
  const contact = (b.contact && typeof b.contact === 'object') ? b.contact : {};
  const name = safeDisplayName(b.displayName || b.legalName || p.businessName || '');
  const addr = addressOf(baseFrom);
  const from = (name && addr) ? ('"' + name + '" <' + addr + '>') : baseFrom;
  const email = String(contact.email || p.businessEmail || '').trim();
  return { from, replyTo: isEmail(email) ? email : null };
}

// ── Company data export (item 10) ────────────────────────────────────────
function companySlug(name, fallback) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || String(fallback || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'company';
}

const TOKEN_URL = /[?&]token=/i;
// Firestore values → plain JSON. Timestamps → ISO strings, GeoPoints →
// {lat,lng}, references → their path. Any string carrying a Storage
// download TOKEN (?token=…, a permanent public link) is dropped and noted —
// the export hands out short-lived signed links instead.
function plain(v, depth) {
  const d = depth || 0;
  if (v == null) return v === undefined ? null : v;
  if (d > 12) return null;
  if (typeof v === 'string') return TOKEN_URL.test(v) ? '[removed: permanent storage link]' : v;
  if (typeof v !== 'object') return v;
  if (typeof v.toDate === 'function') { try { return v.toDate().toISOString(); } catch (_) { return null; } }
  if (v instanceof Date) return v.toISOString();
  if (typeof v.latitude === 'number' && typeof v.longitude === 'number' && Object.keys(v).length <= 2) return { lat: v.latitude, lng: v.longitude };
  if (typeof v.path === 'string' && typeof v.firestore === 'object') return v.path;
  if (Buffer.isBuffer(v)) return null;
  if (Array.isArray(v)) return v.map((x) => plain(x, d + 1));
  const o = {};
  Object.keys(v).forEach((k) => { o[k] = plain(v[k], d + 1); });
  return o;
}

// Same formula-injection neutralizer as the CRM's own CSV exports
// (tests/data-export.test.js pins the class).
function csvCell(v) {
  if (v == null) return '';
  let s = (typeof v === 'object') ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  if (!rows || !rows.length) return '';
  const keys = [];
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (keys.indexOf(k) === -1) keys.push(k); }));
  keys.sort((a, b) => (a === 'id' ? -1 : b === 'id' ? 1 : a.localeCompare(b)));
  return [keys.join(',')].concat(rows.map((r) => keys.map((k) => csvCell(r[k])).join(','))).join('\n');
}

function exportReadme(companyName, counts, photoNote, generatedAt, opts) {
  const truncated = (opts && Array.isArray(opts.truncated)) ? opts.truncated : [];
  const cut = (k) => (truncated.indexOf(k) !== -1
    ? '  (TRUNCATED: this file holds the first ' + ((opts && opts.limit) || counts[k]) + ' records only; contact NBD Pro support for the full set)'
    : '');
  return [
    'Data export — ' + (companyName || 'your company'),
    'Generated ' + generatedAt,
    '',
    'Each collection is here twice: <name>.json (every field) and <name>.csv (one row per record).',
    Object.keys(counts).map((k) => '  ' + k + ': ' + counts[k] + cut(k)).join('\n'),
    '',
    'Photos: photos.json lists every photo with its storage path. ' + photoNote,
    'Permanent public storage links were removed from the records on purpose.',
    'Notes, tasks and activity stored under each lead are not included in this file.',
  ].join('\n');
}

// ── Admin Tenants row (item 6) ───────────────────────────────────────────
function connectStatus(c) {
  const s = c || {};
  if (!String(s.accountId || '').startsWith('acct_')) return 'not started';
  if (s.chargesEnabled === true && s.detailsSubmitted === true) return s.livemode === true ? 'ready' : 'ready (test mode)';
  return 'onboarding';
}
function sitePublishedState(co) {
  const c = co || {};
  if (String(c.status || '') !== 'active') return 'no';
  if (!Object.prototype.hasOwnProperty.call(c, 'sitePublished')) return 'yes (legacy)';
  return c.sitePublished === true ? 'yes' : 'no';
}
function tenantRow(input) {
  const i = input || {};
  const co = i.company || {};
  const sub = i.subscription || {};
  return {
    companyId: i.companyId,
    name: String(co.name || '').slice(0, 120),
    ownerEmail: i.ownerEmail || '',
    plan: sub.plan || 'free',
    status: sub.status || 'none',
    companyStatus: co.status || '',
    leads: i.counts ? i.counts.leads : null,
    estimates: i.counts ? i.counts.estimates : null,
    invoices: i.counts ? i.counts.invoices : null,
    connect: connectStatus(i.connect),
    lastActive: i.lastActive || null,
    sitePublished: sitePublishedState(co),
    createdAt: plain(co.createdAt) || null,
    readOnlyUntil: plain(sub.readOnlyUntil) || null,
  };
}

// ── Platform onboarding emails (item 6) — to the CONTRACTOR, never a homeowner
function signupAlertEmail(company, ownerEmail, companyId) {
  const name = String((company && company.name) || 'A new company');
  return {
    subject: 'New NBD Pro signup: ' + name.slice(0, 80),
    bodyPlain: [
      name + ' just created an NBD Pro account.',
      '',
      'Owner: ' + (ownerEmail || '(no email on the account)'),
      'Company id: ' + companyId,
      'Plan: ' + ((company && company.plan) || 'free'),
      'Source: ' + ((company && company.source) || 'unknown'),
      '',
      'All companies: https://nobigdealwithjoedeal.com/admin/tenants.html',
    ].join('\n'),
  };
}
function welcomeEmail(company) {
  const name = String((company && company.name) || 'your company');
  return {
    subject: 'Welcome to NBD Pro — ' + name.slice(0, 60),
    bodyPlain: [
      'Welcome to NBD Pro, ' + name + '.',
      '',
      'Your dashboard has a short setup checklist on the Home screen:',
      '  1. Add your brand (name, phone, logo)',
      '  2. Import your leads from a CSV — imports don\'t count against your monthly lead limit',
      '  3. Set your package prices',
      '  4. Invite your team (or skip if you work solo)',
      '  5. Connect Stripe to take card payments',
      '  6. Publish your free website',
      '  7. Send your first estimate',
      '',
      'Open your dashboard: https://nobigdealwithjoedeal.com/pro/dashboard.html',
      '',
      'Questions? Reply to this email.',
      '— Joe Deal, NBD Pro',
    ].join('\n'),
  };
}
function trialEndingEmail(planLabel, trialEndMs, amountText) {
  const when = new Date(trialEndMs).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  return {
    subject: 'Your NBD Pro trial ends ' + when,
    bodyPlain: [
      'Your NBD Pro ' + (planLabel || '') + ' trial ends on ' + when + '.',
      '',
      amountText
        ? 'After that, the card on file is charged ' + amountText + ' each month until you cancel.'
        : 'After that, the card on file is charged your plan\'s monthly price until you cancel.',
      'Nothing to do if you want to keep going.',
      '',
      'To change plans or cancel: Settings → Billing → Manage billing in your dashboard,',
      'https://nobigdealwithjoedeal.com/pro/dashboard.html?settings=billing',
      '',
      'If you cancel, your account stays readable for 30 days so you can export everything',
      '(Settings → Access → Export all company data), then it moves to the Free plan.',
      '— NBD Pro',
    ].join('\n'),
  };
}

// The company's cash deposit rule in deposit-rule.js config() shape — the
// server twin of docs/pro/js/tenant-rules.js depositConfig(). NBD: undefined
// (deposit-rule.js's own NBD rule). Another company: its saved
// businessRules.deposit, else NO cash deposit (the neutral default).
function depositConfigFor(companyId, profile) {
  if (!companyId || companyId === NBD_OWNER_UID) return undefined;
  const raw = profile && profile.businessRules && profile.businessRules.deposit;
  if (raw && typeof raw === 'object') {
    const under = Number(raw.noDepositUnderCents), pct = Number(raw.depositPct), round = Number(raw.roundToCents);
    return {
      CASH_NO_DEPOSIT_UNDER_CENTS: (isFinite(under) && under >= 0) ? Math.round(under) : 0,
      CASH_DEPOSIT_PCT: (isFinite(pct) && pct >= 0 && pct <= 100) ? Math.round(pct) : 0,
      CASH_DEPOSIT_ROUND_TO_CENTS: (isFinite(round) && round >= 1) ? Math.round(round) : 2500,
    };
  }
  return { CASH_NO_DEPOSIT_UNDER_CENTS: 0, CASH_DEPOSIT_PCT: 0, CASH_DEPOSIT_ROUND_TO_CENTS: 2500 };
}

function readOnlyUntilFrom(nowMs) {
  return new Date(nowMs + READ_ONLY_GRACE_DAYS * 24 * 3600 * 1000);
}

module.exports = {
  NBD_OWNER_UID,
  READ_ONLY_GRACE_DAYS,
  addressOf,
  safeDisplayName,
  isEmail,
  senderFor,
  companySlug,
  plain,
  csvCell,
  toCsv,
  exportReadme,
  connectStatus,
  sitePublishedState,
  tenantRow,
  signupAlertEmail,
  welcomeEmail,
  trialEndingEmail,
  readOnlyUntilFrom,
  depositConfigFor,
};
