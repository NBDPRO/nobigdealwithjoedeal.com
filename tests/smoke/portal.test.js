/**
 * tests/smoke/portal.test.js — homeowner portal page, BoldSign embed,
 * revoke/regenerate, post-sign booking, customer-facing gallery,
 * Share SSR.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, FUNCTIONS, read, readDashboard, readCustomer, readPortal } = require('./_shared');

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

section('Push-4: homeowner portal page + token callables');
{
  // L-03: portal handlers now live in functions/portal.js, mounted
  // onto index.js exports via Object.assign. Source-scan assertions
  // read from portal.js; the export-liveness check at the end of
  // this file verifies index.js still re-exposes them.
  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  for (const fn of ['createPortalToken', 'getHomeownerPortalView']) {
    assert('exports ' + fn, new RegExp('exports\\.' + fn + '\\s*=').test(psrc));
  }
  // Audit 2026-08-02: mint/revoke authority is the shared pure module —
  // owning rep, same-tenant company_admin, or platform admin.
  assert('createPortalToken gates through canManageLead',
    /require\(['"]\.\/portal-authz['"]\)/.test(psrc) &&
    /if \(!canManageLead\(request\.auth\.token, uid, lead\)\)/.test(psrc));
  assert('getHomeownerPortalView rate-limits by IP',
    /httpRateLimit\(req, res, 'portal:ip'/.test(psrc));
  assert('view response redacts sensitive fields (no claim / notes)',
    /REDACTION:/.test(psrc));
  assert('portal.html exists + reads token from query string',
    fs.existsSync(path.join(ROOT, 'docs/pro/portal.html')));
  const portal = readPortal();
  assert('portal.html fetches getHomeownerPortalView',
    /getHomeownerPortalView/.test(portal));
  // The embed src used to be one literal line ('https://cal.com/' + user +
  // ... + '?embed=true'), so a single /cal\.com.*embed=true/ matched it.
  // The URL now comes from booking-events.js and portal.js only appends
  // the embed params, so the contract spans files — assert each half plus
  // the wiring that joins them, rather than loosening to a bare substring.
  assert('portal.html embeds Cal.com iframe',
    /https:\/\/cal\.com\//.test(portal) &&
    /embed=true/.test(portal) &&
    /class="cal-embed"/.test(portal));
  assert('portal booking iframe src derives from the resolved booking URL',
    /const embedSrc = primary\.url \+/.test(portal));
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('portal_tokens rule denies all client IO',
    /match \/portal_tokens\/\{token\}[\s\S]{0,200}allow read, write: if false/.test(rules));
  assert('measurements rule allows owner reads only',
    /match \/measurements\/\{jobId\}[\s\S]{0,200}isOwner\(resource\.data\.ownerId\)/.test(rules));
  assert('appointments rule allows owner reads only',
    /match \/appointments\/\{bookingId\}[\s\S]{0,200}isOwner\(resource\.data\.userId\)/.test(rules));
  // Audit batch 10: readDashboard() spans dashboard.html AND
  // dashboard-main.js so tests grepping for inline handlers find
  // them regardless of which file the handler lives in.
  assert('dashboard Share Portal Link button wired',
    /_sharePortalLink\s*=\s*async function/.test(readDashboard()));
}

section('Wave B1: portal BoldSign signing embed');
{
  // L-03: portal view lives in portal.js, not index.js.
  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  assert('portal view requests fresh embed URL when awaiting signature',
    /signatureStatus === 'sent'.+signatureStatus === 'viewed'|signature[Ss]tatus === 'sent' \|\| latest\.signatureStatus === 'viewed'/.test(psrc));
  assert('portal view returns signEmbedUrl field',
    /signEmbedUrl:\s*signEmbedUrl/.test(psrc));
  const p = readPortal();
  assert('portal.html renders signing iframe when signEmbedUrl present',
    /awaitingSign && signEmbedUrl/.test(p));
}

section('Wave B4+B5: revoke / regenerate portal link');
{
  // L-03: revokePortalToken moved to portal.js.
  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  assert('revokePortalToken callable exported',
    /exports\.revokePortalToken\s*=/.test(psrc));
  assert('revoke flips expiresAt to past',
    /expiresAt: (?:admin\.firestore\.)?Timestamp\.fromMillis\(Date\.now\(\) - 1\)/.test(psrc));
  // Audit batch 10: also search dashboard-main.js for the extracted
  // helper definition (the inline button still lives in dashboard.html).
  const dash = readDashboard();
  assert('lead detail has Revoke & Regenerate button',
    /Revoke &amp; Regenerate/.test(dash));
  assert('_revokePortalLink helper defined',
    /window\._revokePortalLink\s*=/.test(dash));
}

section('2026-09-25 (review of PR #1777): portal records scoped to the token\'s tenant');
{
  // A re-created lead id passed canManageLead for a stranger, and the portal
  // view found estimates / invoices / e-sign envelopes by leadId alone, so it
  // served the deleted lead's tenant's records (reproduced on the emulator;
  // tests/lead-artifact-cleanup.integration.test.js section P drives the real
  // handler). Behavioral matrix on the REAL pure module.
  const { portalTenant, recordInPortalTenant: inT, tokenMatchesLead } =
    require(path.join(FUNCTIONS, 'portal-authz.js'));
  const lead = { userId: 'rep1', companyId: 'coA' };
  const tok = { leadId: 'L1', ownerUid: 'rep1', companyId: 'coA' };
  const t = portalTenant(tok, lead);
  assert('tenant = the lead\'s companyId', t.companyId === 'coA');
  assert('tenant uids = lead owner + token owner', t.uids.has('rep1') && t.uids.size === 1);
  assert('a legacy lead with no companyId falls back to the token\'s',
    portalTenant({ ownerUid: 'r', companyId: 'coT' }, { userId: 'r' }).companyId === 'coT');
  assert('same-company estimate by a teammate is shown',
    inT({ companyId: 'coA', userId: 'mate' }, ['userId'], t) === true);
  assert('ANOTHER tenant\'s estimate at the same lead id is hidden (the hole)',
    inT({ companyId: 'coB', userId: 'rep1' }, ['userId'], t) === false);
  assert('an unstamped legacy estimate by the lead owner is shown',
    inT({ userId: 'rep1' }, ['userId'], t) === true);
  assert('an unstamped estimate by anyone else is hidden',
    inT({ userId: 'stranger' }, ['userId'], t) === false);
  assert('invoice owner field is createdBy',
    inT({ createdBy: 'rep1' }, ['createdBy'], t) === true && inT({ userId: 'rep1' }, ['createdBy'], t) === false);
  assert('esign envelope with companyId null falls back to ownerUid',
    inT({ companyId: null, ownerUid: 'rep1' }, ['ownerUid'], t) === true);
  assert('a tenant with no companyId hides every stamped record (fail-closed)',
    inT({ companyId: 'coA' }, ['userId'], { companyId: '', uids: new Set(['rep1']) }) === false);
  assert('null record / tenant -> hidden', inT(null, ['userId'], t) === false && inT({}, ['userId'], null) === false);
  assert('a token opens the lead its tenant holds', tokenMatchesLead(tok, lead) === true);
  assert('an old tenant\'s token does not open a re-created lead of another tenant',
    tokenMatchesLead(tok, { userId: 'x', companyId: 'coB' }) === false);
  assert('a legacy token without companyId keeps the old behaviour',
    tokenMatchesLead({ ownerUid: 'rep1' }, { companyId: 'coB' }) === true);

  // Wiring: each of the three leadId-only queries' results goes through it.
  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  assert('portal view refuses a token of another tenant than the lead\'s',
    /if \(!tokenMatchesLead\(tok, lead\)\) \{\s*res\.status\(404\)/.test(psrc));
  assert('portal view filters estimates by tenant',
    /estSnap\.docs\.map\([^\n]*\)\s*\.filter\(e => recordInPortalTenant\(e, \['userId'\], tenant\)\)/.test(psrc));
  assert('portal view filters e-sign envelopes by tenant',
    /if \(!recordInPortalTenant\(e, \['ownerUid'\], tenant\)\) return null;/.test(psrc));
  assert('portal view filters invoices by tenant',
    /\.filter\(inv => recordInPortalTenant\(inv, \['createdBy'\], tenant\)\)/.test(psrc));
  assert('getEstimateForView checks the estimate\'s tenant',
    /recordInPortalTenant\(est, \['userId'\], portalTenant\(tok, tokLead\)\)/.test(psrc));
}

section('Audit 2026-08-02: tenant-admin revoke authority (canManageLead)');
{
  // Behavioral matrix on the REAL pure module (zero-dep require).
  const { canManageLead } = require(path.join(FUNCTIONS, 'portal-authz.js'));
  const lead = { userId: 'rep1', companyId: 'coA' };
  assert('platform admin can manage any lead',
    canManageLead({ role: 'admin' }, 'anyone', lead) === true);
  assert('owning rep can manage their lead',
    canManageLead({ role: 'rep' }, 'rep1', lead) === true);
  assert('same-tenant company_admin can manage (THE fix)',
    canManageLead({ role: 'company_admin', companyId: 'coA' }, 'boss', lead) === true);
  assert('cross-tenant company_admin refused',
    canManageLead({ role: 'company_admin', companyId: 'coB' }, 'boss', lead) === false);
  assert('same-tenant manager refused (only company_admin manages links)',
    canManageLead({ role: 'manager', companyId: 'coA' }, 'mgr', lead) === false);
  assert('missing companyId on claims refuses (fail-closed)',
    canManageLead({ role: 'company_admin' }, 'boss', lead) === false);
  assert('missing companyId on the lead refuses (fail-closed)',
    canManageLead({ role: 'company_admin', companyId: 'coA' }, 'boss', { userId: 'rep1' }) === false);
  assert('null claims / uid / lead refuse (never throw)',
    canManageLead(null, 'u', lead) === false &&
    canManageLead({}, null, lead) === false &&
    canManageLead({}, 'u', null) === false);

  // Static guards on the callable wiring.
  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  assert('revoke lead-path filters through canManage (not platform-admin only)',
    /if \(!canManage && data\.ownerUid !== uid\) return;/.test(psrc));
  assert('revoke is honest: tokens found but none flippable → permission-denied',
    /if \(!q\.empty && revoked\.length === 0\)[\s\S]{0,120}permission-denied/.test(psrc));
  assert('revoked:0 success carries the no_active_tokens reason',
    /reason: 'no_active_tokens'/.test(psrc));
  assert('legacy purge + sign-token revoke gate on canManage',
    /if \(canManage\) \{/.test(psrc) &&
    !/isAdmin \|\| ownerUid === uid/.test(psrc));
}

section('Audit 2026-08-02: shared-estimate whitelist emits retail rows, never raw');
{
  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  assert('portal.js requires the customer-estimate-rows retail ladder',
    /require\(['"]\.\/customer-estimate-rows['"]\)/.test(psrc) &&
    /buildDisplayRows\(est\)/.test(psrc));
  assert('whitelist no longer emits est.lines raw (a field no writer persists)',
    !/lines:\s*Array\.isArray\(est\.lines\)/.test(psrc));
  assert('whitelist no longer emits est.tiers raw',
    !/tiers:\s*est\.tiers \|\| null/.test(psrc));
  assert('safe tiers synthesized from persisted per-SQ prices, grandTotal-only',
    /est\.prices && typeof est\.prices === 'object'/.test(psrc) &&
    /safeTiers\[k\] = \{ grandTotal: Number\(v\) \}/.test(psrc));
  assert('lines map to the estimate-view shape (name/quantity/unit/lineTotal)',
    /lineTotal: r\.total/.test(psrc));
  // The cost-basis fields that pre-sweep V2 rows carry must never appear in
  // the safeEstimate block.
  const block = psrc.slice(psrc.indexOf('const safeEstimate'), psrc.indexOf('const safeEstimate') + 1500);
  assert('safeEstimate never emits cost-basis fields',
    !/materialCostPerUnit|laborCostPerUnit|materialTotal|laborTotal/.test(block));
}

section('Wave B6: post-sign booking promotion');
{
  const p = readPortal();
  assert('portal promotes booking when signedNow',
    /signedNow[\s\S]{0,200}border-color:var\(--green/.test(p));
}

section('Customer-facing portal gallery — share photos with homeowner');
{
  const portal   = read(path.join(ROOT, 'functions/portal.js'));
  const portalUI = readPortal();
  const customer = readCustomer();
  const types    = read(path.join(ROOT, 'docs/pro/js/types.js'));

  // Backend query — must constrain to the rep's own photos
  // (userId == ownerUid) AND only photos the rep flipped to
  // sharedWithHomeowner. Without the second clause, every photo
  // on the lead would leak to the homeowner page.
  assert('getHomeownerPortalView queries shared photos with both gates',
    /\.collection\(['"]photos['"]\)[\s\S]{0,400}\.where\(['"]leadId['"][\s\S]{0,200}\.where\(['"]userId['"][\s\S]{0,200}\.where\(['"]sharedWithHomeowner['"], ['"]==['"], true\)/.test(portal));

  // Hard cap on returned photos so a runaway query can't dump
  // 500 photos to the homeowner page in one fetch.
  assert('shared-photos query is .limit(50) capped',
    /\.where\(['"]sharedWithHomeowner['"][\s\S]{0,200}\.limit\(50\)/.test(portal));

  // Redacted projection — homeowner gets the picture + phase +
  // optional caption, NOTHING ELSE. No internal notes,
  // damageType, severity, location, tags.
  assert('photo projection redacts to id/urls/url/phase/caption only',
    /photos: photoSnap\.docs\.map\([\s\S]{0,400}id:[\s\S]{0,80}urls:[\s\S]{0,80}url:[\s\S]{0,80}phase:[\s\S]{0,80}caption:/.test(portal));
  assert('photo projection does NOT include damageType / severity / tags / description',
    !/photos:[\s\S]{0,800}damageType:/.test(portal)
    && !/photos:[\s\S]{0,800}severity:/.test(portal)
    && !/photos:[\s\S]{0,800}tags:/.test(portal));

  // Frontend gallery render — uses the responsive variants from
  // PR #75 when present, falls back to the original url for
  // legacy / pre-pipeline photos. Window widened in photo-system
  // Phase 5 to account for phase tabs + location chips that now sit
  // between the card header and the photo grid.
  assert('portal.html renders Project Photos card when view.photos non-empty',
    /Project Photos[\s\S]{0,2000}ph-grid/.test(portalUI));
  assert('portal.html emits srcset 200w/600w/1600w for variants',
    /srcset="[^"]*200w[^"]*600w[^"]*1600w/.test(portalUI));
  assert('portal.html falls back to p.url when urls missing',
    /\(p\.urls && p\.urls\.med\)\s*\?\s*esc\(p\.urls\.med\)\s*:\s*esc\(p\.url \|\| ['"]/.test(portalUI));

  // Phase ordering — Before / During / After feels intentional;
  // a hash-table order would put new photos in random places.
  assert('portal.html sorts gallery by phase Before → During → After',
    /phaseOrder\s*=\s*\{[\s\S]{0,80}Before[\s\S]{0,40}During[\s\S]{0,40}After/.test(portalUI));

  // Gallery CSS — purely structural; visual regression covers
  // anything subtler. Just pin the grid + tile classes so a
  // refactor can't accidentally drop them.
  assert('portal.html has .ph-grid + .ph-tile CSS rules',
    /\.ph-grid\s*\{/.test(portalUI) && /\.ph-tile\s*\{/.test(portalUI));

  // Rep-side toggle — buildPhotoBadges emits the share badge as a real <button>
  // whose data-action IS the real global (toggleHomeownerShare) + data-arg, so
  // the generic customer.html delegate routes it even OUTSIDE the #photosByPhase
  // grid (the old hyphenated 'toggle-share' had no window handler → dead there).
  assert('customer.html buildPhotoBadges emits share toggle button',
    /data-action="toggleHomeownerShare" data-arg="' \+ esc\(photo\.id\)/.test(customer));
  assert('customer.html shows different badge for shared vs unshared',
    /if \(photo\.sharedWithHomeowner\)[\s\S]{0,400}Shared[\s\S]{0,400}else[\s\S]{0,400}Share/.test(customer));

  // toggleHomeownerShare optimistic update + Firestore write +
  // revert-on-failure path. All three matter — without revert,
  // a network blip leaves the UI lying about the share state.
  assert('toggleHomeownerShare flips local + writes Firestore + reverts on failure',
    /window\.toggleHomeownerShare = async function/.test(customer)
    && /photo\.sharedWithHomeowner = !prev/.test(customer)
    && /window\.updateDoc\(window\.doc\(window\.db, ['"]photos['"], photoId\)/.test(customer)
    && /catch \(err\)[\s\S]{0,400}photo\.sharedWithHomeowner = prev/.test(customer));

  // Delegated click handler must intercept share clicks BEFORE
  // the lightbox/select branches — otherwise tapping Share also
  // opens the photo editor.
  assert('photo grid delegate routes toggle-share before lightbox/select',
    /var shareBtn = ev\.target\.closest\(['"]\.nbd-share-toggle['"]\)/.test(customer)
    && /ev\.stopPropagation\(\)[\s\S]{0,200}toggleHomeownerShare/.test(customer));

  // Photo projection round-trips the share + caption fields so
  // they survive IDB cache hits + the initial Firestore load.
  assert('photoDocToView preserves sharedWithHomeowner + homeownerCaption',
    /sharedWithHomeowner:\s*!!d\.sharedWithHomeowner/.test(customer)
    && /homeownerCaption:\s*d\.homeownerCaption \|\| ['"]['"]/.test(customer));

  // JSDoc — type doc must reflect the new fields so editor
  // autocomplete picks them up.
  assert('types.js Photo typedef documents sharedWithHomeowner + homeownerCaption',
    /@property \{boolean=\} sharedWithHomeowner/.test(types)
    && /@property \{string=\} homeownerCaption/.test(types));
}

section('Share SSR — server-rendered /share/:token preview');
{
  const ssr      = read(path.join(ROOT, 'functions/share-ssr.js'));
  const idx      = read(FUNCTIONS + '/index.js');
  const fbJson   = JSON.parse(read(path.join(ROOT, 'firebase.json')));

  // Public surface — onRequest export wired into index.js.
  assert('share-ssr exports shareSSR onRequest',
    /exports\.shareSSR\s*=\s*onRequest/.test(ssr));
  assert('functions/index.js wires exports.shareSSR',
    /exports\.shareSSR\s*=\s*_shareSSR\.shareSSR/.test(idx));

  // Hosting rewrite — /share/** must route to the function. The
  // matcher uses ** (not :token) because Firebase Hosting v1
  // rewrites accept globs; the function reads the token off
  // req.path with its own regex.
  const shareRewrite = (fbJson.hosting && fbJson.hosting.rewrites || [])
    .find(r => r.source === '/share/**');
  assert('firebase.json rewrites /share/** → shareSSR cloud function',
    !!shareRewrite
    && shareRewrite.function
    && shareRewrite.function.functionId === 'shareSSR');

  // GET-only — POST/PUT/DELETE on this endpoint should not run
  // any work. The 405 response also needs the Allow header so a
  // crawler retrying with GET knows what to do.
  assert('shareSSR rejects non-GET methods with 405 + Allow header',
    /req\.method !== ['"]GET['"]/.test(ssr)
    && /res\.set\(['"]Allow['"], ['"]GET['"]\)\.status\(405\)/.test(ssr));

  // Token regex — must constrain length + alphabet to match the
  // 24-char no-confusable mintPortalToken format. A liberal regex
  // would let attackers smuggle path traversal or filesystem-y
  // characters into the Firestore lookup.
  assert('TOKEN_RE constrains to alphanumeric, 10-64 chars',
    /TOKEN_RE\s*=\s*\/\^\[A-Z0-9\]\{10,64\}\$\/i/.test(ssr));

  // Per-IP rate limit — must run BEFORE any Firestore reads, or
  // a brute-force token sweep would burn read quota.
  assert('rate limit runs before Firestore lookup',
    /httpRateLimit\(req, res, ['"]shareSSR:ip['"], 120, 60_000\)/.test(ssr));

  // Locked-down CSP + noindex on every response. Homeowner data
  // must not leak via injected script and must not get indexed.
  assert('every response sets tight CSP + X-Robots-Tag noindex',
    /res\.set\(['"]Content-Security-Policy['"][\s\S]{0,200}default-src ['"]none['"]/.test(ssr)
    && /res\.set\(['"]X-Robots-Tag['"], ['"]noindex, nofollow['"]\)/.test(ssr));

  // OG + Twitter Card meta — the whole point. Without these the
  // crawler renders "no preview".
  assert('renderPage emits og:title + og:description + twitter:card',
    /og:title/.test(ssr) && /og:description/.test(ssr)
    && /twitter:card/.test(ssr));

  // HTML escape — lead.firstName / address / rep.displayName are
  // user-controlled and end up in the body + the og:title attr.
  assert('escHtml escapes &<>"\\\' ',
    /escHtml\(s\)[\s\S]{0,400}\.replace\(\/&\/g[\s\S]{0,200}\.replace\(\/'\/g/.test(ssr));
  assert('every interpolation goes through escHtml',
    /\$\{safeTitle\}/.test(ssr) && /\$\{safeCompany\}/.test(ssr)
    && /\$\{safeRepName\}/.test(ssr));
  // Phase-2.2 (Audit #2) privacy: link-preview crawlers cache og: meta and
  // a forwarded/group-thread link renders with NO click, so the share
  // preview must NOT expose the homeowner's full name or street address —
  // those stay behind the token-gated portal. First-name greeting only.
  assert('share preview omits full street address + full name',
    !/\$\{safeAddr\}/.test(ssr) && !/\$\{safeFullName\}/.test(ssr));

  // Token usage counter MUST NOT increment on preview crawls —
  // otherwise iMessage previewing the link would count as 4-5
  // opens before the homeowner ever clicks.
  assert('shareSSR does NOT increment portal_tokens uses counter',
    /deliberately NOT incrementing tok\.uses/i.test(ssr)
    && !/tok\.uses\s*\+\s*1/.test(ssr)
    && !/uses:\s*FieldValue\.increment/.test(ssr));

  // Expired tokens render a branded 410 page, not a raw 404 —
  // crawlers ignoring 404s would leave a "broken link" preview.
  assert('expired token renders 410 with branded HTML',
    /function expiredPage\(\)[\s\S]{0,500}status:\s*410/.test(ssr));

  // CTA hands off to the existing client-rendered portal.
  assert('project page CTA links to /pro/portal.html?token=',
    /\/pro\/portal\.html\?token=\$\{encodeURIComponent\(safeToken\)\}/.test(ssr));

  // Failure isolation — a Firestore exception must not 500.
  // The crawler still gets a branded preview.
  assert('catch block falls back to notFoundPage instead of 500',
    /catch \(err\)[\s\S]{0,400}send\(notFoundPage\(\)\)/.test(ssr));
}

};
