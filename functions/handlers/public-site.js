/**
 * NBD PRO — public tenant-site config (Pillar 5 phase 1)
 * ═══════════════════════════════════════════════════════════════
 * getPublicSiteConfig: the read path behind /sites/t/ — the data-driven
 * tenant microsite that replaces hand-authoring a docs/sites/<tenant>/
 * folder per company (the way docs/sites/oaks/ was built). The template
 * is one static page; THIS endpoint supplies everything tenant-specific,
 * resolved live from companies/{id} + companyProfile/{id}.
 *
 * Why a server endpoint instead of a client Firestore read: companyProfile
 * is rules-scoped to the tenant's own team — a public site can't (and
 * shouldn't) read the raw doc. This endpoint reads it server-side and
 * returns a strict PUBLIC-MARKETING whitelist:
 *   name/displayName, tagline, logoUrl, colors, serviceArea,
 *   contact { phone, email, website, address }, services[]
 * and NEVER: alertEmail/alertSms (lead routing), integrations (Twilio/
 * Cal/Slack endpoints), pricing, legal text, doc numbering.
 *
 * Lookup key: the companyId itself (an unguessable auth uid) or a
 * human slug via companies/{id}.siteSlug (equality query, auto-indexed).
 * Only companies EXPLICITLY marked status:'active' are served — publishing
 * a tenant microsite is a deliberate release to that company, and an absent
 * status means unpublished (see isPublishedCompany; this fails closed as of
 * 2026-08-17, where it previously served). Since 2026-10-04 a NEW tenant also
 * needs sitePublished:true, set only by the owner's publishTenantSite call
 * (isPublishedCompany has the details). A tenant superseded by a team
 * invite stops resolving for lead tagging too.
 *
 * The raw companyProfile doc stores only what the tenant actually set
 * (Pillar 2 override semantics), so nothing NBD-branded can leak into
 * another company's site: absent fields simply aren't in the payload
 * and the template renders its own neutral fallbacks.
 */

'use strict';

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { httpRateLimit } = require('../integrations/upstash-ratelimit');
const { CORS_ORIGINS, requireTeamAdmin } = require('./_shared');
const { callableRateLimit } = require('../shared');

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

function s(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Only serve a value that is a real hex color. The client already re-validates
// before installing it as a CSS custom property, but validating server-side
// too means no future consumer can be handed a `url(...)`-style payload in a
// colors.* field. Non-hex → '' (the template falls back to its neutral default).
function hex(v) {
  const c = s(v, 20);
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '';
}

// Resolve a public site key (company doc id OR siteSlug) to the tenant.
// Returns { companyId, co } for an active tenant (legacy status-less docs
// still serve), else null. Exported so submitPublicLead's siteKey
// lead-tagging resolves tenants IDENTICALLY to this endpoint — one
// resolver, one notion of "a real, active tenant".
async function resolveCompanyByKey(db, key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  let companyId = key;
  let coSnap = await db.doc(`companies/${key}`).get();
  if (!coSnap.exists) {
    const slugSnap = await db.collection('companies')
      .where('siteSlug', '==', key).limit(1).get();
    if (slugSnap.empty) return null;
    coSnap = slugSnap.docs[0];
    companyId = coSnap.id;
  }
  const co = coSnap.data() || {};
  if (co.status && co.status !== 'active') return null;
  return { companyId, co };
}

// ── Publication gate (Jo, 2026-08-17) ──────────────────────────
// A tenant microsite is a DELIBERATE RELEASE to that company, not a side
// effect of the tenant existing. Only companies explicitly marked
// status:'active' are served to the public web.
//
// FAIL CLOSED: an absent status means unpublished. Until this gate, absent
// status SERVED — /sites/t/oaks answered 200 with the tenant's name, phone
// and address to anyone who guessed the id (they are short words like
// 'oaks'/'nbd', not the unguessable auth uids this file's header assumes).
// X-Robots-Tag noindex kept those pages out of search results but never made
// them private. Any company doc predating this gate must therefore be stamped
// by scripts/backfill-company-status.js BEFORE this deploys, or its site goes
// dark at cutover.
//
// Deliberately NOT folded into resolveCompanyByKey above. That resolver
// answers "is this a real, non-superseded tenant" and is shared with
// submitPublicLead's lead tagging (handlers/integrations.js) — gating it
// there too would untag a real tenant's inbound leads and misroute them to
// the default pipeline, which is exactly the P1 HIGH regression the 2026-07
// tenant-lifecycle audit fixed. Three states, kept separate on purpose:
//   status 'active'               → real tenant, PUBLISHED   (site + tagging)
//   status absent                 → real tenant, unpublished (tagging only)
//   'superseded-by-invite' / etc. → not a tenant at all      (neither)
//
// ── Separate site-publish flag (2026-10-04) ────────────────────
// `status:'active'` ALSO means "a working CRM tenant", and createCompany
// stamps it on every free self-serve signup — so before this flag anyone
// could sign up and get a page under nobigdealwithjoedeal.com with any name
// and phone the moment provisioning finished (a phishing page on Jo's
// domain). The site now has its own flag, `sitePublished`:
//   true            → published (set ONLY by publishTenantSite, below, after
//                     the brand name, phone and service area are filled)
//   false / any other value → unpublished (createCompany and setSiteSlug's
//                     ensure-path write false for every new tenant)
//   ABSENT          → a tenant that existed before the flag: keeps the
//                     status-only behaviour, so no prod doc changes at
//                     cutover. Only the admin SDK can create such a doc now —
//                     firestore.rules forbid a client create/update from
//                     setting status, sitePublished or sitePublishedAt.
// To unpublish a legacy tenant, set sitePublished:false on its companies doc.
function isPublishedCompany(co) {
  const c = co || {};
  if (String(c.status || '') !== 'active') return false;
  if (!Object.prototype.hasOwnProperty.call(c, 'sitePublished')) return true;
  return c.sitePublished === true;
}

// What publishTenantSite requires before it will flip sitePublished:true —
// read through buildPublicConfig so "filled" means exactly what the public
// page would show (a private alertSms number does not count as a phone).
function sitePublishReadiness(companyId, companyDoc, profileDoc) {
  const cfg = buildPublicConfig(companyId, companyDoc, profileDoc);
  const missing = [];
  if (!cfg.displayName) missing.push('brand name');
  if (String(cfg.contact.phone || '').replace(/[^\d]/g, '').length < 10) missing.push('phone');
  if (!cfg.serviceArea) missing.push('service area');
  return { ready: missing.length === 0, missing };
}

// Pure whitelist builder — exported for unit tests. Takes the RAW
// companies/{id} + companyProfile/{id} docs and returns exactly the
// public payload (no alert routing, no integrations, no pricing).
function buildPublicConfig(companyId, companyDoc, profileDoc) {
  const co = companyDoc || {};
  const p = profileDoc || {};
  const b = p.brand || {};
  const c = b.contact || {};

  const services = Array.isArray(p.services)
    ? p.services.slice(0, 12).map((sv) => ({
        icon: s(sv && sv.icon, 8),
        name: s(sv && sv.name, 80),
        desc: s(sv && sv.desc, 200),
      })).filter((sv) => sv.name)
    : [];

  const colors = b.colors || {};
  return {
    ok: true,
    // P5 indirection (tenant-lifecycle audit, resolved 2026-08-06): the
    // template needs a stable key only to TAG leads, and the slug already
    // is that key. Return the slug when one is configured — the tenant's
    // Firebase uid is no longer echoed to callers who looked up by slug.
    // A slug-less tenant is reachable only by uid URL, so returning the
    // caller's own key discloses nothing new there.
    siteKey: s(co.siteSlug, 64) || companyId,
    name: s(b.legalName, 80) || s(co.name, 80),
    displayName: s(b.displayName, 80) || s(b.legalName, 80) || s(co.name, 80),
    tagline: s(b.tagline, 160),
    logoUrl: /^https:\/\//.test(String(b.logoUrl || '')) ? s(b.logoUrl, 300) : '',
    colors: {
      primary: hex(colors.primary),
      accent: hex(colors.accent),
    },
    serviceArea: s(b.serviceArea, 120) || s(p.serviceArea, 120),
    contact: {
      phone: s(c.phone, 30) || s(p.businessPhone, 30),
      email: s(c.email, 200) || s(p.businessEmail, 200),
      website: s(c.website, 200) || s(p.businessWebsite, 200),
      address: s(c.address, 300) || s(p.businessAddress, 300),
    },
    services,
  };
}

exports.getPublicSiteConfig = onRequest(
  {
    region: 'us-central1',
    maxInstances: 10,
    memory: '256MiB',
    timeoutSeconds: 15,
  },
  async (req, res) => {
    // The global firebase.json '**' header stamps `public, max-age=300` on
    // every hosting response, INCLUDING function rewrites. Left as-is, a 404/
    // 429/500 from this endpoint would be edge-cached for 5 minutes — a
    // cached 429 is a per-edge tenant-site blackout. Force no-store up front;
    // the 200 path re-sets its own cacheable value below.
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.status(405).json({ ok: false }); return; }
    if (!(await httpRateLimit(req, res, 'siteConfig:ip', 60, 60_000))) return;

    const key = String(req.query.company || '').trim();
    if (!KEY_RE.test(key)) { res.status(400).json({ ok: false, reason: 'bad_key' }); return; }

    try {
      const db = getFirestore();
      // Shared resolver: doc-id or siteSlug, superseded/disabled tenants
      // stop resolving, legacy status-less docs still serve.
      const hit = await resolveCompanyByKey(db, key);
      if (!hit) { res.status(404).json({ ok: false, reason: 'not_found' }); return; }
      const { companyId, co } = hit;

      // Publication gate — see isPublishedCompany. The SAME opaque 404 as an
      // unknown key, deliberately: a prober must not be able to tell "this
      // tenant exists but isn't released yet" from "no such tenant". Reusing
      // reason:'not_found' is what keeps an unreleased partner's existence
      // from leaking through the error channel.
      if (!isPublishedCompany(co)) {
        res.status(404).json({ ok: false, reason: 'not_found' });
        return;
      }

      const pSnap = await db.doc(`companyProfile/${companyId}`).get();
      const cfg = buildPublicConfig(companyId, co, pSnap.exists ? pSnap.data() : {});
      if (!cfg.name) { res.status(404).json({ ok: false, reason: 'not_found' }); return; }

      // Edge/browser cacheable — brand edits show up within 5 minutes.
      res.set('Cache-Control', 'public, max-age=300');
      res.status(200).json(cfg);
    } catch (e) {
      logger.error('getPublicSiteConfig failed', { err: e.message });
      res.status(500).json({ ok: false, reason: 'internal' });
    }
  }
);

// ───────────────────────────────────────────────────────────────
// setSiteSlug — Settings surface for the pretty microsite URL.
// Server-side because slugs must be validated against a reserved
// list and checked for uniqueness across ALL tenants — neither is
// enforceable from a client write.
// ───────────────────────────────────────────────────────────────
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
// Names that collide with real routes/surfaces or the platform brand.
const RESERVED_SLUGS = new Set([
  't', 'oaks', 'template', 'nbd', 'nbdpro', 'api', 'admin', 'pro', 'www',
  'sites', 'free-guide', 'blog', 'assets', 'estimate', 'storm', 'contact',
  'index', 'site', 'app', 'help', 'support',
]);

// Exported for unit tests.
function validateSlug(raw) {
  const slug = String(raw || '').trim().toLowerCase();
  if (!slug) return { slug: '' }; // empty = clear
  if (slug.length < 3 || slug.length > 40 || !SLUG_RE.test(slug)) {
    return { error: 'Use 3-40 lowercase letters, numbers, and hyphens (no leading/trailing hyphen).' };
  }
  if (RESERVED_SLUGS.has(slug)) return { error: 'That name is reserved — pick another.' };
  return { slug };
}

exports.setSiteSlug = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    await callableRateLimit(request, 'setSiteSlug', 10, 3_600_000);
    const { uid, companyId } = await requireTeamAdmin(request);

    const v = validateSlug(request.data && request.data.slug);
    if (v.error) throw new HttpsError('invalid-argument', v.error);

    const db = getFirestore();
    const coRef = db.doc(`companies/${companyId}`);

    // Uniqueness via a claim doc `siteSlugs/{slug}` inside a transaction.
    // A plain check-then-write on companies.siteSlug does NOT close the race:
    // two owners claiming the same slug write DIFFERENT company docs, so
    // Firestore sees no write-write conflict and both commit. Contending on
    // the SAME siteSlugs/{slug} doc makes exactly one win; the loser retries,
    // sees it occupied, and fails. companies.siteSlug stays authoritative for
    // getPublicSiteConfig's lookup; the claim doc is admin-SDK-only (default
    // deny) and exists purely as the lock + reverse index.
    const slugRef = v.slug ? db.doc(`siteSlugs/${v.slug}`) : null;

    await db.runTransaction(async (tx) => {
      const coSnap = await tx.get(coRef);
      if (!coSnap.exists && companyId !== uid) {
        throw new HttpsError('failed-precondition', 'Company not found.');
      }
      const prevSlug = coSnap.exists ? (coSnap.data() || {}).siteSlug : null;

      if (slugRef) {
        const claim = await tx.get(slugRef);
        if (claim.exists && (claim.data() || {}).companyId !== companyId) {
          throw new HttpsError('already-exists', 'That name is taken — pick another.');
        }
      }

      // Pre-Phase-2 solo owner with no company doc yet — create it.
      if (!coSnap.exists) {
        tx.set(coRef, {
          ownerId: uid,
          name: request.auth.token.name || 'My Company',
          status: 'active',
          // A new tenant's site starts unpublished (see isPublishedCompany).
          sitePublished: false,
          plan: 'free',
          source: 'slug-ensure',
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      // Release the previous slug's claim if it's changing/clearing.
      if (prevSlug && prevSlug !== v.slug) {
        tx.delete(db.doc(`siteSlugs/${prevSlug}`));
      }
      if (slugRef) {
        tx.set(slugRef, { companyId, updatedAt: FieldValue.serverTimestamp() });
      }
      tx.set(coRef, v.slug
        ? { siteSlug: v.slug, siteSlugUpdatedAt: FieldValue.serverTimestamp() }
        : { siteSlug: FieldValue.delete(), siteSlugUpdatedAt: FieldValue.serverTimestamp() },
        { merge: true });
    });

    logger.info('setSiteSlug', { companyId, slug: v.slug || '(cleared)' });
    return { ok: true, slug: v.slug, url: '/sites/t/' + (v.slug || companyId) };
  }
);

// ───────────────────────────────────────────────────────────────
// publishTenantSite — the owner's "Publish my site" / "Unpublish" action.
// The ONLY writer of companies/{id}.sitePublished (firestore.rules make it
// client-immutable). Publishing requires the brand name, a public phone and
// a service area to be filled, so a half-configured signup can't put a page
// on Jo's domain. Owner (or platform admin) only — a company_admin can edit
// the profile but the public release is the owner's call.
//   data: { publish?: boolean }   (default true; false unpublishes)
// ───────────────────────────────────────────────────────────────
exports.publishTenantSite = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    await callableRateLimit(request, 'publishTenantSite', 10, 3_600_000);
    const { uid, companyId } = await requireTeamAdmin(request, null, { ownerOnly: true });
    const publish = !(request.data && request.data.publish === false);

    const db = getFirestore();
    const coRef = db.doc(`companies/${companyId}`);
    const coSnap = await coRef.get();
    if (!coSnap.exists) {
      throw new HttpsError('failed-precondition', 'Finish setting up your company first.');
    }
    const co = coSnap.data() || {};
    if (String(co.status || '') !== 'active') {
      throw new HttpsError('failed-precondition', 'This company is not active, so its site cannot be published.');
    }

    if (!publish) {
      await coRef.set({
        sitePublished: false,
        siteUnpublishedAt: FieldValue.serverTimestamp(),
        siteUnpublishedBy: uid,
      }, { merge: true });
      logger.info('publishTenantSite', { companyId, published: false });
      return { ok: true, published: false };
    }

    const pSnap = await db.doc(`companyProfile/${companyId}`).get();
    const r = sitePublishReadiness(companyId, co, pSnap.exists ? pSnap.data() : {});
    if (!r.ready) {
      throw new HttpsError('failed-precondition',
        'Before publishing, add your ' + r.missing.join(', ') + ' in Settings → Company Profile.',
        { missing: r.missing });
    }

    await coRef.set({
      sitePublished: true,
      sitePublishedAt: FieldValue.serverTimestamp(),
      sitePublishedBy: uid,
    }, { merge: true });
    logger.info('publishTenantSite', { companyId, published: true });
    return { ok: true, published: true, url: '/sites/t/' + (s(co.siteSlug, 64) || companyId) };
  }
);

exports.resolveCompanyByKey = resolveCompanyByKey;
exports.isPublishedCompany = isPublishedCompany;
exports._test = { buildPublicConfig, validateSlug, resolveCompanyByKey, isPublishedCompany, sitePublishReadiness };
