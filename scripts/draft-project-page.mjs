#!/usr/bin/env node
/**
 * draft-project-page.mjs — draft a docs/assets/data/projects.json entry from
 * one consented CRM job (content plan 2026-11-09 §2 step 2).
 *
 * The job's own data, read ONCE and read-only, becomes a draft entry that
 * follows documentation/runbooks/PUBLISH-PROJECT.md:
 *   - refuses unless leads/{id}.projectConsent.on === true (the owner's
 *     consent tick, docs/pro/js/project-consent.js; firestore.rules lets only
 *     the owner side write it). That tick is what consentOnFile: true attests.
 *   - refuses a joint or subcontracted job (a sub on the job: subId, or the
 *     legacy free-text crew; or jointJob / subcontracted marked true). Runbook
 *     hard rule 3: how such a job is presented is Jo's call, not a script's.
 *   - town only ("Mason, OH"), never the street; a rounded retail RANGE from
 *     lead.jobValue, never the sold price and never a cost / margin figure;
 *   - case-study fields (problem, scope, materials, timeline) from the job only
 *     when the text is clean: any house number, phone, email, URL, dollar
 *     figure, cost word or the customer's name drops the field with a warning;
 *   - fresh alt text from a template, never CRM photo captions or locations.
 *     The alt text and description are DRAFTS: read them against the photos.
 *
 * Default is a DRY RUN: it prints the entry and the next steps. --write
 * appends it to the LOCAL docs/assets/data/projects.json (a repo file, not
 * production) and prints the prepare-project-images.mjs / build-projects.mjs
 * steps. Nothing here writes Firestore, and nothing opens a PR.
 *
 * Usage:
 *   NBD_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     node scripts/draft-project-page.mjs --lead <leadId> [--project <id>]
 *   node scripts/draft-project-page.mjs --from <lead export .json>
 * Options:
 *   --photos <n>        photos you will export for the page (default 3)
 *   --published <date>  YYYY-MM-DD (default today); a future date stages it
 *   --services a,b      override the services derived from the job
 *   --year <yyyy>       when the job has no completion date on file
 *   --slug <slug>       choose the slug (kebab-case)
 *   --projects <path>   projects.json to read / --write (tests use a copy)
 *   --write             append the entry to that projects.json
 *
 * Tested by tests/draft-project-page-2026-11-09.test.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_PROJECTS = path.join(ROOT, 'docs', 'assets', 'data', 'projects.json');

// The service keys scripts/build-projects.mjs accepts (that build is the gate;
// this copy only checks --services). The labels word the draft title and tag.
export const SERVICE_LABELS = {
  'roof-replacement': 'Roof Replacement',
  'roof-repair': 'Roof Repair',
  'commercial-roofing': 'Commercial Roofing',
  'siding-replacement': 'Siding Replacement',
  'siding-repair': 'Siding Repair',
  'wood-siding-repair': 'Wood Siding Repair',
  'shed-roof-replacement': 'Shed Roof Replacement',
  'gutter-replacement': 'Gutters',
  'gutter-cleaning': 'Gutter Cleaning',
  'storm-damage': 'Storm Damage',
  'roof-inspection': 'Roof Inspection',
  'interior-repair': 'Interior Repair',
};

const STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM '
  + 'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC').split(' '));
const CITY_RE = /^[A-Za-z][A-Za-z .'-]*, [A-Z]{2}$/;   // build-projects.mjs's town shape
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const str = (v) => (v == null ? '' : String(v)).trim();

// Firestore Timestamp (SDK or REST export), Date, ISO string or ms -> Date | null.
export function toDate(v) {
  if (v == null || v === '') return null;
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'string' || typeof v === 'number') d = new Date(v);
  else if (typeof v.toDate === 'function') d = v.toDate();
  else if (typeof v.seconds === 'number') d = new Date(v.seconds * 1000);
  else if (typeof v._seconds === 'number') d = new Date(v._seconds * 1000);
  return d && !isNaN(d.getTime()) ? d : null;
}

// ── refusals ─────────────────────────────────────────────────────────
export function refusalFor(lead) {
  const l = lead || {};
  if (!(l.projectConsent && l.projectConsent.on === true)) {
    return 'no project-page consent on this job: the owner ticks it on the customer page (Project Page) first. '
      + 'Without lead.projectConsent.on === true there is no consentOnFile.';
  }
  const why = [];
  if (str(l.subId)) why.push('a sub is assigned (subId)');
  if (str(l.crew)) why.push('a crew is named (crew)');
  if (l.jointJob === true || l.joint === true) why.push('it is marked joint');
  if (l.subcontracted === true) why.push('it is marked subcontracted');
  if (why.length) {
    return 'this job needs Jo\'s call before it is published: ' + why.join(', ') + '. '
      + 'Runbook hard rule 3 (documentation/runbooks/PUBLISH-PROJECT.md): a joint or subcontracted job goes to Jo, '
      + 'who decides how it is presented; publish it by hand through the runbook once he has.';
  }
  return null;
}

// ── town only ────────────────────────────────────────────────────────
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).replace(/\s+/g, ' ').trim();

export function townFromLead(lead) {
  const l = lead || {};
  const city = str(l.city);
  const st = str(l.state).toUpperCase();
  if (city && STATES.has(st) && !/\d/.test(city)) {
    const t = titleCase(city) + ', ' + st;
    return CITY_RE.test(t) ? t : null;
  }
  const parts = str(l.address).split(',').map((p) => p.trim()).filter(Boolean);
  // The first part is the street; the town is never taken from it.
  for (let i = parts.length - 1; i >= 1; i--) {
    const stOnly = /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(parts[i]);
    if (stOnly && STATES.has(stOnly[1])) {
      const town = parts[i - 1];
      if (i - 1 >= 1 && /^[A-Za-z][A-Za-z .'-]*$/.test(town)) return titleCase(town) + ', ' + stOnly[1];
      return null;
    }
    const both = /^([A-Za-z][A-Za-z .'-]*?)\s+([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(parts[i]);
    if (both && STATES.has(both[2])) return titleCase(both[1]) + ', ' + both[2];
  }
  return null;
}

// ── rounded retail range ─────────────────────────────────────────────
// About ±10% around the sold price, widened outward to the runbook's rounding
// ($1,000 from $10k, $500 from $1k, $100 below), so the page never shows what
// one household paid. Only the retail jobValue is read; no cost field ever is.
export function roundedRange(jobValue) {
  const v = Number(jobValue);
  if (!Number.isFinite(v) || v <= 0) return null;
  const step = v >= 10000 ? 1000 : v >= 1000 ? 500 : 100;
  let low = Math.floor((v * 0.9) / step) * step;
  let high = Math.ceil((v * 1.1) / step) * step;
  if (low <= 0) low = step;
  if (low >= v) low -= step;
  if (high <= v) high += step;
  if (low <= 0) return { priceLow: step, priceHigh: Math.max(high, step * 2) };
  return { priceLow: low, priceHigh: high };
}

// ── services ─────────────────────────────────────────────────────────
function jobText(l) {
  return [l.jobType, l.damageType, l.scopeOfWork, l.subType].map(str).filter(Boolean).join(' \n ').toLowerCase();
}
export function servicesFromLead(lead) {
  const t = jobText(lead || {});
  if (!t) return [];
  const out = [];
  if (/\b(hail|storm|wind)\b/.test(t)) out.push('storm-damage');
  const shed = /\bshed\b|outbuilding/.test(t);
  const roofReplace = /re-?roof|tear[- ]?off|tore off|new roof|roof replacement|replace[ds]?(?: the)? roof|full replacement|shingle roof/.test(t);
  if (shed && /roof|shingle/.test(t)) out.push('shed-roof-replacement');
  else if (roofReplace) out.push('roof-replacement');
  else if (/\b(roof|shingles?|flashing|leak)\b/.test(t) && /repair|fix|patch|leak|replaced (?:a few|some|missing)/.test(t)) out.push('roof-repair');
  if (/siding/.test(t)) out.push(/replace|new siding|re-?side/.test(t) ? 'siding-replacement' : 'siding-repair');
  if (/gutter|downspout/.test(t)) out.push(/clean/.test(t) && !/replace|install|new/.test(t) ? 'gutter-cleaning' : 'gutter-replacement');
  if (!out.length && /inspection/.test(t)) out.push('roof-inspection');
  return out;
}

// ── clean job text only ──────────────────────────────────────────────
// Returns the cleaned text, or '' with the reason, so the caller can warn.
export function cleanJobText(text, lead) {
  const s = str(text).replace(/\s+/g, ' ');
  if (!s) return { text: '', why: '' };
  const l = lead || {};
  const names = [l.firstName, l.lastName, l.name, l.customerName].map(str).filter((n) => n.length >= 3);
  const checks = [
    [/\b\d{1,6}\s+[A-Za-z]/, 'a house number or address'],
    [/\d{3}[-.\s)]+\d{3}[-.\s]+\d{4}/, 'a phone number'],
    [/@/, 'an email'],
    [/https?:|www\./i, 'a link'],
    [/\$|\b\d[\d,]*\s*(?:dollars|usd)\b/i, 'a dollar figure'],
    [/cost|margin|markup|profit|contractor|supplier|wholesale/i, 'a cost or margin word'],
    [/\b(?:street|st\.|avenue|ave\.|lane|ln\.|drive|dr\.|court|ct\.|road|rd\.|blvd)\b/i, 'a street name'],
  ];
  for (const [re, why] of checks) if (re.test(s)) return { text: '', why };
  for (const n of names) if (s.toLowerCase().includes(n.toLowerCase())) return { text: '', why: 'the customer\'s name' };
  if (s.length > 600) return { text: '', why: 'over 600 characters' };
  return { text: s, why: '' };
}

function completedOn(l) {
  const direct = toDate(l.installCompletedAt);
  if (direct) return direct;
  const hist = Array.isArray(l.stageHistory) ? l.stageHistory : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i] || {};
    if (h.to === 'install_complete') {
      const d = toDate(h.timestamp || h.at);
      if (d) return d;
    }
  }
  return toDate(l.completedAt);
}

const kebab = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ── the entry ────────────────────────────────────────────────────────
export function buildEntry(lead, opts = {}) {
  const l = lead || {};
  const refusal = refusalFor(l);
  if (refusal) throw new Error(refusal);
  const warnings = [];

  const city = townFromLead(l);
  if (!city) throw new Error('no town on this job (city/state fields or "street, Town, ST zip" address): the page needs "Town, ST"');
  const town = city.split(',')[0];

  const services = Array.isArray(opts.services) && opts.services.length ? opts.services.slice() : servicesFromLead(l);
  if (!services.length) throw new Error('could not tell the service from the job: pass --services (' + Object.keys(SERVICE_LABELS).join(',') + ')');
  for (const s of services) if (!(s in SERVICE_LABELS)) throw new Error('unknown service "' + s + '": one of ' + Object.keys(SERVICE_LABELS).join(','));

  const done = completedOn(l);
  const year = Number.isInteger(opts.year) ? opts.year : (done ? done.getFullYear() : null);
  if (!Number.isInteger(year)) throw new Error('no completion date on this job: pass --year <yyyy> (the runbook requires a year)');
  if (!done) warnings.push('no install-complete date on the job; timeline left out');

  const main = services.find((s) => s !== 'storm-damage') || services[0];
  const hail = /\bhail\b/.test(jobText(l));
  const storm = services.includes('storm-damage') && main !== 'storm-damage';
  const label = SERVICE_LABELS[main];
  const tag = services.includes('storm-damage') ? (hail ? 'Hail Damage' : 'Storm Damage') : label;
  const title = storm ? (hail ? 'Hail' : 'Storm') + ' Damage → ' + label : label;

  let slug = opts.slug ? str(opts.slug) : [kebab(town), city.slice(-2).toLowerCase(), main, String(year)].join('-');
  if (!SLUG_RE.test(slug)) throw new Error('slug "' + slug + '" must be kebab-case');
  const taken = new Set(opts.existingSlugs || []);
  if (!opts.slug && taken.has(slug)) {
    let n = 2;
    while (taken.has(slug + '-' + n)) n++;
    slug = slug + '-' + n;
  }

  const n = Math.max(1, Math.min(12, Number.parseInt(opts.photos, 10) || 3));
  const what = label.toLowerCase();
  // Fresh alt text from a template: never CRM photo captions or locations.
  const photos = [];
  for (let i = 1; i <= n; i++) {
    const alt = i === 1
      ? 'Finished ' + what + ' on a home in ' + town
      : (i === n && n > 2 ? 'The completed ' + what + ' on a home in ' + town + ', another angle' : what.charAt(0).toUpperCase() + what.slice(1) + ' work on a home in ' + town + ', photo ' + i + ' of ' + n);
    photos.push({ src: '/assets/images/projects/' + slug + '-' + i + '.jpg', alt });
  }
  warnings.push('alt text and description are drafts: read each against its photo and rewrite in your words');

  const scope = cleanJobText(l.scopeOfWork, l);
  if (str(l.scopeOfWork) && !scope.text) warnings.push('scope left out: the job\'s scope of work has ' + scope.why);
  const problemSrc = cleanJobText(l.damageType, l);
  if (str(l.damageType) && !problemSrc.text) warnings.push('problem left out: the damage type has ' + problemSrc.why);
  const materialsSrc = cleanJobText(l.roofType || l.shingleType || l.material, l);

  const firstSentence = scope.text ? (scope.text.match(/^[^.!?]+[.!?]/) || [scope.text])[0].trim() : '';
  const description = firstSentence || (label + ' for a homeowner in ' + town + ', ' + year + '.');

  const entry = { slug, title, services, tag, city };
  const range = roundedRange(l.jobValue);
  if (range) Object.assign(entry, range);
  else warnings.push('no jobValue on the job; price range left out (allowed)');
  entry.year = year;
  entry.description = description;
  if (problemSrc.text) entry.problem = /damage/i.test(problemSrc.text) ? problemSrc.text.replace(/[.\s]*$/, '.') : problemSrc.text + ' damage.';
  if (scope.text) entry.scope = scope.text;
  if (materialsSrc.text) entry.materials = materialsSrc.text;
  if (done) entry.timeline = 'Finished in ' + done.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' }) + '.';
  entry.hero = photos[0].src;
  entry.photos = photos;
  entry.consentOnFile = true;
  entry.published = opts.published || todayYmd();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.published)) throw new Error('--published must be YYYY-MM-DD');

  return { entry, warnings };
}

// ── CLI ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--write') a.write = true;
    else if (k === '--lead') a.lead = next();
    else if (k === '--from') a.from = next();
    else if (k === '--project') a.project = next();
    else if (k === '--photos') a.photos = next();
    else if (k === '--published') a.published = next();
    else if (k === '--services') a.services = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--year') a.year = Number.parseInt(next(), 10);
    else if (k === '--slug') a.slug = next();
    else if (k === '--projects') a.projects = next();
    else throw new Error('unknown option ' + k);
  }
  return a;
}

function defaultProject() {
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
    return (rc.projects && rc.projects.default) || null;
  } catch (e) { return null; }
}

async function readLead(args) {
  if (args.from) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args.from), 'utf8'));
    return raw && raw.lead && typeof raw.lead === 'object' ? raw.lead : raw;
  }
  const token = process.env.NBD_ACCESS_TOKEN;
  if (!token) throw new Error('--lead reads production read-only with a short-lived token: set NBD_ACCESS_TOKEN=$(gcloud auth print-access-token), or use --from <export.json>');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(args.lead))) throw new Error('lead id must be a Firestore id');
  const projectId = args.project || defaultProject();
  if (!projectId) throw new Error('no Firebase project: pass --project');
  const require = createRequire(import.meta.url);
  const R = require('./_firestore-rest.js');
  const db = R.restFirestore({ projectId, token });
  const snap = await db.doc('leads/' + args.lead).get();
  if (!snap.exists) throw new Error('lead ' + args.lead + ' not found');
  return Object.assign({ id: args.lead }, snap.data());
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (!args.lead && !args.from) {
    console.error('usage: node scripts/draft-project-page.mjs (--lead <leadId> | --from <lead.json>) [--photos n] [--published YYYY-MM-DD] [--services a,b] [--year yyyy] [--slug s] [--write]');
    process.exit(2);
  }
  const projectsPath = path.resolve(args.projects || DEFAULT_PROJECTS);
  try {
    const lead = await readLead(args);
    const manifest = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
    const list = Array.isArray(manifest.projects) ? manifest.projects : [];
    const slugs = list.map((p) => p && p.slug).filter(Boolean);
    const opts = { photos: args.photos, published: args.published, services: args.services, year: args.year, slug: args.slug };

    // Strict for --write: a base slug already on file is probably this job again.
    const { entry, warnings } = buildEntry(lead, Object.assign({}, opts, { existingSlugs: args.write ? [] : slugs }));
    if (args.write && slugs.includes(entry.slug)) {
      throw new Error('a project with slug "' + entry.slug + '" is already in ' + path.relative(ROOT, projectsPath)
        + '. If this is a different job, pass --slug <another-slug>.');
    }

    console.log((args.write ? 'WRITE' : 'DRY RUN') + ': project page draft for lead ' + (lead.id || args.lead || '(export)')
      + ' (consent ticked ' + (toDate(lead.projectConsent.at) ? toDate(lead.projectConsent.at).toISOString().slice(0, 10) : 'on file') + ')');
    for (const w of warnings) console.log('  ! ' + w);
    console.log(JSON.stringify(entry, null, 2));

    const n = entry.photos.length;
    const photoArgs = Array.from({ length: n }, (_, i) => '<photo' + (i + 1) + '.jpg>').join(' ');
    if (args.write) {
      list.push(entry);
      manifest.projects = list;
      fs.writeFileSync(projectsPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log('\nAppended to ' + path.relative(ROOT, projectsPath) + '. Next:');
    } else {
      console.log('\nDry run: nothing written. Add --write to append it to ' + path.relative(ROOT, projectsPath) + '. Then:');
    }
    console.log('  1. Export the ' + n + ' ORIGINAL photo(s) from the CRM photo hub (download, not a link), then re-encode:');
    console.log('       node scripts/prepare-project-images.mjs ' + entry.slug + ' ' + photoArgs);
    console.log('  2. Rewrite the alt text and description against the photos, in your words.');
    console.log('  3. node scripts/build-projects.mjs && node scripts/build-projects.mjs --check');
    console.log('  4. node scripts/check-site-integrity.js --quiet && node tests/catalog-cost-privacy.test.js');
    console.log('  5. Commit every stamped file on a branch and open a PR (documentation/runbooks/PUBLISH-PROJECT.md).');
  } catch (e) {
    console.error('REFUSED: ' + e.message);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main();
