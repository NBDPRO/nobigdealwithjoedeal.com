/**
 * tests/smoke/crm.test.js — bulk lead operations, NBDIDBCache, customer
 * photo strip/grid/multi-select/upload, cross-lead photo feed, Firestore
 * repository layer, JSDoc typedefs, view template-hydration sweep.
 */

'use strict';

const path = require('path');
const { ROOT, PRO_JS, read, readCustomer, readDashboardMain, readDashboardStyles, readCrm } = require('./_shared');

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

section('NBDIDBCache — IndexedDB offline-first cache');
{
  const idb      = read(path.join(ROOT, 'docs/pro/js/idb-cache.js'));
  const customer = readCustomer();

  // Public surface — these names are the integration contract.
  assert('idb-cache exports get/put/clear/clearAll/revalidate/setActiveUid on window.NBDIDBCache',
    /window\.NBDIDBCache\s*=\s*api/.test(idb)
    && /get:\s*get/.test(idb)
    && /put:\s*put/.test(idb)
    && /clear:\s*clear/.test(idb)
    && /clearAll:\s*clearAll/.test(idb)
    && /revalidate:\s*revalidate/.test(idb)
    && /setActiveUid:\s*setActiveUid/.test(idb));

  // Per-uid partition is non-negotiable — two reps sharing a
  // device must NOT see each other's cached PII.
  assert('DB name includes uid to partition cache per account',
    /nbd-pro-cache-['"]?\s*\+\s*\(uid \|\| ['"]anon['"]\)/.test(idb));
  assert('setActiveUid resets dbPromise to force re-open with new name',
    /function setActiveUid\(uid\)[\s\S]{0,400}dbPromise\s*=\s*null/.test(idb));

  // Graceful no-IDB fallback. Critical for Safari private mode +
  // embedded WebViews where IndexedDB throws synchronously on
  // open(). Every method must resolve with a sentinel rather
  // than reject.
  assert('openDB resolves null when indexedDB is undefined',
    /typeof indexedDB === ['"]undefined['"][\s\S]{0,200}Promise\.resolve\(null\)/.test(idb));
  assert('openDB swallows synchronous open() throws',
    /try \{[\s\S]{0,200}indexedDB\.open\([\s\S]{0,200}catch \(err\)[\s\S]{0,200}resolve\(null\)/.test(idb));

  // Promise wrapper for IDBRequest — single primitive everything
  // else builds on. Must resolve on success, reject on error.
  assert('idbReq resolves on success and rejects on error',
    /function idbReq\(req\)[\s\S]{0,300}req\.onsuccess[\s\S]{0,200}req\.onerror[\s\S]{0,200}reject/.test(idb));

  // revalidate semantics:
  //  - cache hit fires onCached SYNCHRONOUSLY for instant paint
  //  - loader runs in parallel; on success, fresh data replaces
  //    cache + is returned
  //  - on loader failure, return cached data (offline mode)
  assert('revalidate fires onCached when cache fresh',
    /if \(rec && \(Date\.now\(\) - \(rec\.at \|\| 0\)\) <= maxAgeMs\)[\s\S]{0,300}onCached\(rec\.data\)/.test(idb));
  assert('revalidate falls back to cached data on loader failure',
    /\.catch\(function \(err\)[\s\S]{0,300}return rec\.data/.test(idb));

  // Cache write is fire-and-forget — must not block the caller
  // on IDB latency.
  assert('revalidate does not await put(slice, fresh)',
    /\.then\(function \(fresh\) \{[\s\S]{0,200}put\(slice, fresh\);[\s\S]{0,80}return fresh/.test(idb));

  // Customer page wiring — script tag, auth hooks, photo loader.
  assert('customer.html loads idb-cache.js after state-store.js',
    /state-store\.js[\s\S]{0,400}idb-cache\.js/.test(customer));
  assert('customer.html calls setActiveUid(user.uid) on signin',
    /NBDIDBCache\.setActiveUid\(user\.uid\)/.test(customer));
  assert('customer.html calls clearAll() on signout',
    /window\.NBDIDBCache && window\.NBDIDBCache\.clearAll\(\)/.test(customer));

  // Single projection function — guarantees cache hit + fresh
  // fetch produce identical objects (no flicker on revalidate).
  // 2026-09-17: fetchFresh's own getDocs()+forEach() was replaced by
  // customer-bootstrap.module.js's shared, in-flight-deduped
  // _fetchPhotosRaw(leadId) (the loadPhotos()/loadPhotosByPhase() fetch-
  // unification) — photoDocToView still runs as a .map() over that raw
  // array, so it's still the one and only Firestore→view projection.
  assert('photoDocToView is the single Firestore→view projection',
    /function photoDocToView\(id, d\)/.test(customer)
    && /raw\.map\(function \(d\) \{ return photoDocToView\(d\.id, d\); \}\)/.test(customer));

  // urls + storagePath must round-trip through the cache so the
  // <img srcset> render path keeps working from cached entries.
  assert('photoDocToView preserves urls + storagePath fields',
    /urls:\s*d\.urls \|\| null/.test(customer)
    && /storagePath:\s*d\.storagePath \|\| ['"]/.test(customer));

  // Cache key includes uid so a different rep on the same device
  // doesn't read the previous account's photo cache.
  assert('cache key namespaced by uid + leadId',
    /['"]photos:['"]\s*\+\s*uid\s*\+\s*['"]:[\"']\s*\+\s*leadId/.test(customer));

  // Sanity-bounded freshness — don't show year-stale photos.
  assert('photos.maxAgeMs ≤ 30 days',
    /maxAgeMs:\s*30\s*\*\s*86400000/.test(customer));

  // Backward compat: no NBDIDBCache → plain Firestore path with
  // the same view code.
  assert('no-IDB fallback runs fetchFresh + applyPhotosToView',
    /if \(!window\.NBDIDBCache\)[\s\S]{0,300}fetchFresh\(\)[\s\S]{0,200}applyPhotosToView\(list\)/.test(customer));
}

section('Bulk lead operations — writeBatch + NBDStore + new fields');
{
  // Step 4b: crm.js was split into 4 modules + a shim — concat them
  // via readCrm() so the bulk-section assertions below find their
  // patterns regardless of which split file the code landed in.
  const crm  = readCrm();
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));

  // Selection state must live in NBDStore now — direct mutation
  // of window._bulkSelected would skip subscriber notify.
  assert('crm.js seeds leads.bulkSelected slice in NBDStore',
    /NBDStore\.set\(['"]leads\.bulkSelected['"], new Set\(\)\)/.test(crm));
  assert('crm.js binds _bulkSelected → leads.bulkSelected (one-way)',
    /NBDStore\.bind\(['"]_bulkSelected['"], ['"]leads\.bulkSelected['"]\)/.test(crm));
  assert('crm.js subscribes updateBulkToolbar to leads.bulkSelected',
    /NBDStore\.subscribe\(['"]leads\.bulkSelected['"][\s\S]{0,200}updateBulkToolbar/.test(crm));

  // updateBulkSelection swaps the Set ref every write — required
  // for the NBDStore identity-equality short-circuit to fire.
  assert('updateBulkSelection swaps Set ref to trigger notify',
    /function updateBulkSelection\(mutate\)[\s\S]{0,400}var next = new Set\(prev\);[\s\S]{0,200}NBDStore\.set\(['"]leads\.bulkSelected['"], next\)/.test(crm)
    || /function updateBulkSelection\(mutate\)[\s\S]{0,400}const next = new Set\(prev\);[\s\S]{0,200}NBDStore\.set\(['"]leads\.bulkSelected['"], next\)/.test(crm));

  // bulkDelete must use writeBatch — the previous serial loop did
  // N round-trips and was non-atomic. commitBulkLeadOp is the
  // single place batches are formed.
  assert('bulkDelete routes through commitBulkLeadOp (writeBatch)',
    /async function bulkDelete\(\)[\s\S]{0,1500}commitBulkLeadOp/.test(crm));
  // Window widened 500→1600 (2026-07-06): the ownership pre-filter for
  // team visibility (staff kanbans can select teammate-owned cards whose
  // writes are rules-denied — one denied doc voids an atomic batch) sits
  // between the function head and the writeBatch call.
  assert('commitBulkLeadOp uses writeBatch + chunk cap < 500',
    /async function commitBulkLeadOp[\s\S]{0,2400}window\.writeBatch\(window\.db\)/.test(crm)
    && /CHUNK\s*=\s*450/.test(crm));

  // New bulk capabilities — carrier + damage. These are the
  // direct UX wins; without them Joe was hand-editing 20+ leads
  // one at a time after a hailstorm sweep.
  assert('bulkAssignCarrier reads bulkCarrierSelect.value',
    /async function bulkAssignCarrier\(\)[\s\S]{0,300}bulkCarrierSelect[\s\S]{0,200}bulkAssignField\(['"]insCarrier['"]/.test(crm));  // the lead form's field (R14, 2026-09-28)
  assert('bulkAssignDamage reads bulkDamageSelect.value',
    /async function bulkAssignDamage\(\)[\s\S]{0,300}bulkDamageSelect[\s\S]{0,200}bulkAssignField\(['"]damageType['"]/.test(crm));

  // Field allowlist — privileged fields (companyId, role, isAdmin)
  // must NOT be writable through this path, even though
  // firestore.rules already blocks them. Defense in depth.
  // Wave 32 extended the set with source + jobType for bulk
  // post-import cleanup; the test rewrites against the same shape
  // and explicitly asserts the privileged-field guard separately.
  assert('BULK_LEAD_FIELDS allowlist constrains writable fields',
    /BULK_LEAD_FIELDS\s*=\s*new Set\(\[['"]insCarrier['"], ['"]damageType['"], ['"]followUp['"], ['"]tags['"], ['"]source['"], ['"]jobType['"]\]\)/.test(crm));
  // Privileged-field exclusion sanity check — these must NEVER
  // appear in the allowlist no matter how it's expanded.
  assert('BULK_LEAD_FIELDS does not allow privileged fields',
    !/BULK_LEAD_FIELDS\s*=\s*new Set\(\[[^\]]*['"](?:companyId|role|isAdmin|userId|deleted)['"][^\]]*\]\)/.test(crm));
  assert('bulkAssignField rejects non-allowlisted fields',
    /if \(!BULK_LEAD_FIELDS\.has\(field\)\)[\s\S]{0,200}return;/.test(crm));

  // Optimistic local update so the kanban reflects without a
  // full reload. Must run AFTER batch.commit succeeds.
  assert('bulkAssignField patches local _leads + re-renders',
    /\(window\._leads \|\| \[\]\)\.forEach[\s\S]{0,200}l\[field\] = value/.test(crm));

  // Select-all-visible — Joe's #1 ask after hailstorm sweeps.
  assert('selectAllVisibleLeads gathers visible .k-card data-id',
    /function selectAllVisibleLeads\(\)/.test(crm)
    && /\.querySelectorAll\(['"]\.kanban-board \.k-card['"]\)/.test(crm)
    && /next\.add\(id\)/.test(crm));

  // Toolbar UI — new selects + buttons must be in the DOM.
  assert('dashboard.html bulk toolbar has bulkCarrierSelect + bulkDamageSelect',
    /id="bulkCarrierSelect"/.test(dash) && /id="bulkDamageSelect"/.test(dash));
  assert('dashboard.html toolbar wires bulkAssignCarrier + bulkAssignDamage',
    /data-action="call" data-fn="bulkAssignCarrier"/.test(dash)
    && /data-action="call" data-fn="bulkAssignDamage"/.test(dash));
  assert('dashboard.html toolbar has Select-all-visible button',
    /data-action="call" data-fn="selectAllVisibleLeads"/.test(dash));

  // Public API — every helper exposed on window so inline
  // onclick handlers can reach them. Globals Tranche 2c-3 (2026-07-07):
  // the markup-only bulk handlers now REGISTER in __NBD_CALL_REGISTRY
  // (crm-portal-bridge.js is IIFE-wrapped) instead of living on window;
  // updateBulkToolbar keeps its window export (internal + cross-file
  // callers). The dashboard.test.js Tranche 2c section pins the full
  // registration + allowlist-removal + off-window surface.
  assert('bulk toolbar handlers register in __NBD_CALL_REGISTRY (Tranche 2c-3)',
    /bulkAssignCarrier:\s*bulkAssignCarrier/.test(crm)
    && /bulkAssignDamage:\s*bulkAssignDamage/.test(crm)
    && /selectAllVisibleLeads:\s*selectAllVisibleLeads/.test(crm));
  assert('updateBulkToolbar stays window-exported (internal + cross-file callers)',
    /window\.updateBulkToolbar\s*=\s*updateBulkToolbar/.test(crm));
}

section('Firestore repository layer — write convention');
{
  const repos = read(path.join(ROOT, 'docs/pro/js/repos.js'));
  // Public API surface — three repos with matching shapes.
  assert('repos.js exports window.NBDRepos with leads/photos/estimates',
    /window\.NBDRepos\s*=\s*\{[\s\S]*leads:\s*leads[\s\S]*photos:\s*photos[\s\S]*estimates:\s*estimates/.test(repos));
  // stampCreate fills the 4 system fields exactly once. The Object.assign
  // pattern with caller data SECOND lets backfill scripts override the
  // stamps when they need to (e.g. preserving createdAt on imports).
  assert('stampCreate stamps userId + companyId + createdAt + updatedAt',
    /function stampCreate\([\s\S]{0,500}userId:\s*ctx\.uid[\s\S]{0,200}companyId:\s*ctx\.companyId[\s\S]{0,200}createdAt:\s*st[\s\S]{0,100}updatedAt:\s*st/.test(repos));
  // stampUpdate forces updatedAt — call sites must not override.
  assert('stampUpdate forces server updatedAt (caller cannot bump)',
    /function stampUpdate[\s\S]{0,300}Object\.assign\(\{\},\s*data,\s*\{\s*updatedAt:\s*st\s*\}\)/.test(repos));
  // context() throws fast on missing uid (better than letting
  // firestore.rules reject later). companyId falls back to uid for
  // solo operators per audit batch 6 — the original strict throw
  // blocked adoption since solo accounts don't carry a separate
  // companyId on their claims.
  assert('context() throws unauthenticated when uid missing',
    /code\s*=\s*['"]unauthenticated['"]/.test(repos));
  // Bulk write helpers use writeBatch — atomic round-trip.
  assert('photos.bulkUpdate uses writeBatch',
    /bulkUpdate:\s*async function[\s\S]{0,300}window\.writeBatch\(window\.db\)/.test(repos));
  // Soft-delete sets deleted:true rather than calling deleteDoc,
  // because cross-collection references would orphan otherwise.
  assert('leads.softDelete sets deleted:true (not deleteDoc)',
    /softDelete:\s*async function[\s\S]{0,200}deleted:\s*true/.test(repos)
    && /hardDelete:\s*async function[\s\S]{0,200}window\.deleteDoc/.test(repos));
}

section('JSDoc typedefs — Firestore document shapes');
{
  const types = read(path.join(ROOT, 'docs/pro/js/types.js'));
  // The five core typedefs every domain file should reach for.
  ['Lead', 'Photo', 'Estimate', 'UserProfile', 'Company', 'LeadActivity'].forEach(function (t) {
    assert('types.js declares @typedef ' + t,
      new RegExp('@typedef\\s+\\{object\\}\\s+' + t).test(types));
  });
  // Photo must include the new `.order` field documented as PR #68's
  // drag-rearranged sequence — otherwise the comparator will look like
  // it's reading a phantom field.
  assert('Photo typedef documents the .order field',
    /@property\s*\{number=\}\s*order/.test(types));
  // Lead must include .companyId since PR #60 made it required.
  assert('Lead typedef documents .companyId as required-on-create',
    /@property\s*\{string\}\s*companyId/.test(types));
  // The TimestampLike alias normalizes the three formats Firestore
  // hands back across server-set, client-set, and unset paths.
  assert('types.js declares TimestampLike alias for FirestoreTimestamp/string/number/null',
    /@typedef\s*\{FirestoreTimestamp[\s\S]{0,80}TimestampLike/.test(types));
}

section('Customer overview photo strip — cap + drag reorder');
{
  const customer = readCustomer();
  // 25-cap on the overview photo strip (matches the dashboard's
  // PHOTO_PHASE_CAP pattern from PR #63).
  assert('overview strip caps at 25 with show-all toggle',
    /window\.PHOTO_OVERVIEW_CAP\s*=\s*25/.test(customer)
    && /toggleCustomerPhotosExpanded/.test(customer)
    && /nbd-photo-show-all-btn/.test(customer));
  // Comparator that prefers numeric .order, falls back to uploadedAt.
  assert('photos sort by .order field (drag-rearranged sequence first)',
    /function nbdComparePhotos\(a, b\)/.test(customer)
    && /typeof a\.order === 'number'/.test(customer));
  // Reorder mode is a body-class toggle so CSS shows drag affordance.
  assert('reorder mode toggle exposes draggable grid via body class',
    /document\.body\.classList\.toggle\('nbd-photo-reorder'\)/.test(customer)
    && /body\.nbd-photo-reorder \.nbd-photo-item/.test(customer));
  // HTML5 drag/drop wiring on the overview strip.
  assert('overview strip wires dragstart/dragover/drop handlers',
    /listEl\.addEventListener\('dragstart'/.test(customer)
    && /listEl\.addEventListener\('dragover'/.test(customer)
    && /listEl\.addEventListener\('drop'/.test(customer));
  // writeBatch persists the new order — one round-trip for the whole
  // sequence (same pattern as the multi-select feature).
  assert('persistCustomerPhotoOrder uses writeBatch',
    /async function persistCustomerPhotoOrder\(\)[\s\S]{0,400}window\.writeBatch\(window\.db\)[\s\S]{0,400}batch\.update\(/.test(customer));
  // GAP CLOSED 2026-09-06. History, because it is the instructive part: this
  // originally asserted "generatePhotoReport iterates photos sorted by
  // nbdComparePhotos" and PASSED — but only because readCustomer() concatenates
  // customer-photo-report-generator.js, whose window.generatePhotoReport
  // photo-report.js overwrote at load. It was guarding a renderer that never
  // ran, while the report that actually shipped sorted by createdAt and threw
  // away the rep's drag order. Deleting the dead code exposed that; the fix
  // followed. photo-report.js now sorts with _comparePhotoReportOrder, whose
  // behaviour is unit-tested in tests/smoke/photo-report-pairs.test.js against
  // the real exported function rather than by grepping source.
  assert('the live photo report honours the rep drag order',
    /photos\.sort\(_comparePhotoReportOrder\)/.test(read(path.join(PRO_JS, 'photo-report.js'))),
    'the report must sort by the persisted `order` field, not createdAt alone — otherwise the PDF disagrees with the gallery the rep arranged');
}

section('Customer photo multi-select + batched commit');
{
  const customer = readCustomer();
  // writeBatch must be imported AND exposed on window so the bulk
  // handlers can invoke it.
  assert('customer.html imports writeBatch from firestore SDK',
    /import \{[^}]*writeBatch[^}]*\}\s*from\s*"https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-firestore\.js"/.test(customer));
  assert('customer.html exposes window.writeBatch',
    /window\.writeBatch\s*=\s*writeBatch/.test(customer));
  // _photoSelected Set + tile checkbox overlay + bulk action bar DOM.
  assert('customer.html declares window._photoSelected Set',
    /window\._photoSelected\s*=\s*window\._photoSelected\s*\|\|\s*new Set/.test(customer));
  assert('photo tile renders the selection checkbox span',
    /class="nbd-photo-checkbox"/.test(customer));
  assert('bulk action bar DOM is in place',
    /id="nbdPhotoBulkBar"[\s\S]{0,1500}id="nbdPhotoBulkCount"[\s\S]{0,2000}id="nbdBulkPhase"[\s\S]{0,2000}id="nbdBulkSeverity"/.test(customer));
  // Bulk handlers exist and use writeBatch (one round-trip for the
  // whole batch — the whole point of this PR).
  // 2026-09-08: the damageType normalize-on-write guard landed between the
  // signature and the batch, widening the gap past 500 — bound bumped to 900,
  // the same adjustment the delete assertion below already took. The claim
  // under test is unchanged: this handler still batches into one round-trip.
  assert('applyBulkPhotoUpdate uses writeBatch',
    /window\.applyBulkPhotoUpdate\s*=\s*async function[\s\S]{0,900}window\.writeBatch\(window\.db\)/.test(customer));
  // NEW-C1 added a nbdConfirm gate before the batch (PWA confirm patch),
  // widening the gap from `async function` to writeBatch — bound bumped 500→900.
  assert('applyBulkPhotoDelete uses writeBatch',
    /window\.applyBulkPhotoDelete\s*=\s*async function[\s\S]{0,900}window\.writeBatch\(window\.db\)[\s\S]{0,500}batch\.delete\(/.test(customer));
  // After a same-field bulk update, surgical updates happen — no full
  // re-render unless the phase changed.
  assert('bulk update prefers surgical updatePhotoTile over full re-render',
    /phaseChanged[\s\S]{0,200}updatePhotoTile\(id\)/.test(customer));
  // Click delegate enters selection mode without opening the quick-edit popup.
  assert('photo grid delegate routes selection-mode clicks to togglePhotoSelection',
    /isPhotoSelectMode\(\)[\s\S]{0,150}togglePhotoSelection\(photoId\)/.test(customer));
}

section('Customer photo upload — background-safe + global widget');
{
  const customer = readCustomer();
  // Global floating upload widget DOM exists.
  assert('customer.html ships the #nbdUploadWidget DOM',
    /id="nbdUploadWidget"[\s\S]{0,500}id="nbdUploadWidgetBarFill"/.test(customer));
  // updateGlobalUploadStatus drives the widget visibility + bar fill.
  assert('customer.html exports updateGlobalUploadStatus',
    /function updateGlobalUploadStatus\(\)/.test(customer));
  // Surgical per-tick update — kills the per-byte innerHTML thrash.
  assert('uploadSinglePhoto state_changed uses updateUploadPreviewItem',
    /uploadTask\.on\(['"]state_changed['"][\s\S]{0,400}updateUploadPreviewItem\(index\)/.test(customer));
  // Per-tile % label overlay (the "loading circle on each photo").
  assert('preview tile shows centered % label',
    /class="preview-progress-pct"/.test(customer)
    && /\.preview-progress-pct\s*\{[^}]*transform:\s*translate/.test(customer));
  // closeUploadModal must NOT clear the queue while uploads are in flight.
  assert('closeUploadModal preserves queue mid-upload (background-safe)',
    /hasInflight[\s\S]{0,150}return;/.test(customer));
  // Success path is a non-blocking toast, not a JS alert. Negative
  // condition targets the photo path only (_uploadQueue) so the
  // doc-upload alert at line ~1860 (_docUploadQueue) doesn't trigger.
  assert('uploadPhotos success path uses showToast (no alert)',
    /window\.showToast\(['"]✓ Uploaded /.test(customer)
    && !/alert\(`Successfully uploaded \$\{window\._uploadQueue/.test(customer));
}

section('Customer photo grid — surgical render path');
{
  const customer = readCustomer();
  // _photoById Map for O(1) lookup (was O(n) indexOf inside the render loop).
  assert('customer.html populates window._photoById Map in loadPhotosByPhase',
    /window\._photoById\s*=\s*new Map\(\)/.test(customer));
  // Surgical update entry point — patches one tile's badges in place.
  assert('customer.html exports updatePhotoTile helper',
    /function updatePhotoTile\(photoId\)/.test(customer));
  // Tiles must carry the stable id so updatePhotoTile can find them.
  assert('customer.html photo tiles use data-photo-id (not data-photo-global-idx)',
    /data-photo-id="/.test(customer) && !/data-photo-global-idx/.test(customer));
  // Single delegated click listener — replaces 80 per-tile listeners.
  assert('customer.html photo grid uses delegated click listener',
    /ensurePhotoGridDelegate/.test(customer)
    && /grid\.addEventListener\(['"]click['"]/.test(customer));
  // CSS hover replaces the JS mouseover/mouseout pair (160 listeners on 80 photos).
  assert('customer.html .nbd-phase-photo:hover is CSS, not JS',
    /\.nbd-phase-photo:hover\s*\{\s*transform:\s*scale/.test(customer)
    && !/addEventListener\(['"]mouseover['"]/.test(customer));
  // Per-phase 25-photo cap with show-all toggle.
  assert('customer.html caps each phase to 25 with show-all toggle',
    /PHOTO_PHASE_CAP\s*=\s*25/.test(customer)
    && /toggleShowAllPhase/.test(customer)
    && /nbd-show-all-btn/.test(customer));
  // quickSaveMeta must call updatePhotoTile when the phase didn't
  // change — the whole point of this PR.
  assert('quickSaveMeta calls updatePhotoTile for same-phase edits',
    /updates\.phase === prevPhase[\s\S]{0,80}updatePhotoTile\(photo\.id\)/.test(customer));
}

section('Phase D.2 — Cross-lead Recent Photo Feed');
{
  const dash = readDashboardStyles(); // html + extracted css (Rock 4 Phase 2b-d)
  const mainJs = readDashboardMain();

  // 1. Mode toggle present in tpl-view-photos.
  assert('tpl-view-photos has the .ph-mode-toggle (By Property / Recent)',
    /<div class="ph-mode-toggle"[\s\S]{0,400}data-ph-mode="by-property"[\s\S]{0,400}data-ph-mode="recent"/.test(dash),
    'expected the by-property + recent mode buttons inside the photo template');

  // 2. Recent feed mount + CSS.
  assert('photoRecentFeed mount div present',
    /<div id="photoRecentFeed" class="ph-recent-feed"/.test(dash),
    'expected photoRecentFeed mount inside tpl-view-photos');
  assert('.ph-recent-grid CSS defined (3-up grid)',
    /\.ph-recent-grid\{[\s\S]{0,200}grid-template-columns:\s*repeat\(auto-fill/.test(dash),
    'expected .ph-recent-grid CSS rule');

  // 3. JS exports.
  assert('window.setPhotoMode exposed',
    /window\.setPhotoMode\s*=/.test(mainJs),
    'expected window.setPhotoMode export');
  assert('window.renderRecentPhotoFeed exposed',
    /window\.renderRecentPhotoFeed\s*=/.test(mainJs),
    'expected window.renderRecentPhotoFeed export');

  // 4. Query uses where(userId == uid) + orderBy(createdAt desc) + limit.
  //    createdAt is the canonical /photos ordering field (every write path
  //    stamps it) — ordering by the photo-engine-only uploadedAt silently
  //    excluded quick-upload / annotation photos from the feed.
  assert('renderRecentPhotoFeed queries photos by userId + orderBy createdAt + limit',
    /window\.query\(\s*window\.collection\(window\.db,\s*'photos'\)[\s\S]{0,200}window\.where\('userId',\s*'==',\s*uid\)[\s\S]{0,200}window\.orderBy\('createdAt',\s*'desc'\)[\s\S]{0,200}window\.limit\(/.test(mainJs),
    'expected Firestore query: where(userId == uid).orderBy(createdAt,desc).limit()');

  // 5. Date grouping uses Today / Yesterday smart labels.
  assert('renderRecentPhotoFeed renders Today / Yesterday smart date labels',
    /'Today'/.test(mainJs) && /'Yesterday'/.test(mainJs),
    'expected Today / Yesterday labels in the date-grouper');

  // 6. Tap on a tile pivots into by-property mode for that lead.
  //    The string in source is `setPhotoMode(\\'by-property\\')` (escaped
  //    quotes inside an HTML onclick attribute).
  assert('Recent tiles wire data-dw-action=openPhotoTile (delegated → setPhotoMode by-property)',
    /data-dw-action="openPhotoTile"/.test(mainJs) && /setPhotoMode\('by-property'\)/.test(mainJs),
    'expected recent-tile data-dw-action + delegate that calls setPhotoMode("by-property")');
}

section('Phase C.1 + C.2 — view template-hydration sweep');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const mainJs = readDashboardMain();

  // C.1 — every stub view should be an empty mount div + matching template.
  // Whitespace between attributes is flexible (some are aligned in columns).
  const stubs = ['aitree','understand','projectcodex','aiusage','products','d2d','training','academy','closeboard','repos','board','home'];
  for (const v of stubs) {
    assert('view-' + v + ' is an empty mount with data-view-template',
      new RegExp('<div class="view( active)?" id="view-' + v + '"\\s+data-view-template="tpl-view-' + v + '"></div>').test(dash),
      'expected mount div for view-' + v);
    assert('<template id="tpl-view-' + v + '"> exists',
      new RegExp('<template id="tpl-view-' + v + '">').test(dash),
      'expected tpl-view-' + v + ' template element');
  }

  // C.2 — medium views (joe + schedule) extracted.
  for (const v of ['joe','schedule']) {
    assert('view-' + v + ' is an empty mount with data-view-template (C.2)',
      new RegExp('<div class="view" id="view-' + v + '"\\s+data-view-template="tpl-view-' + v + '"></div>').test(dash),
      'expected mount div for view-' + v);
    assert('<template id="tpl-view-' + v + '"> exists',
      new RegExp('<template id="tpl-view-' + v + '">').test(dash),
      'expected tpl-view-' + v + ' template element');
  }

  // Eager-hydration helper runs at module load (covers default-active home).
  assert('dashboard-main.js eager-hydrates .view.active[data-view-template] on load',
    /_eagerHydrateActiveViews[\s\S]{0,400}\.view\.active\[data-view-template\]/.test(mainJs),
    'expected _eagerHydrateActiveViews IIFE that queries .view.active[data-view-template]');
}

section('backfill — leads.stageRole one-off (freeform-pipeline classification)');
{
  const fs = require('fs');
  const p = path.join(ROOT, 'scripts/backfill-lead-stageRole.js');
  assert('scripts/backfill-lead-stageRole.js exists', fs.existsSync(p));
  if (fs.existsSync(p)) {
    const bf = read(p);
    // Reuse the SHARED server role map so the backfill can't drift from runtime.
    assert('backfill imports the shared roleFromKey (no drift vs functions/stage-roles)',
      /require\(['"]\.\.\/functions\/stage-roles['"]\)/.test(bf) && /roleFromKey\(/.test(bf));
    assert('stageRole backfill is dry-run-by-default + --apply needs --yes',
      /APPLY && !YES/.test(bf) && /--apply --yes/.test(bf));
    // The persisted role is authoritative — only FILL gaps, never overwrite.
    assert('stageRole backfill is idempotent (skips docs with a valid stageRole)',
      /VALID_ROLES\.has\(data\.stageRole\)/.test(bf));
    // A tenant's custom-stage role (companyProfile.pipelines) must win over the
    // key-map guess — that's the whole point (custom stages classify wrong
    // under the key map alone).
    assert('stageRole backfill resolves a tenant custom-stage role from companyProfile.pipelines',
      /companyProfile/.test(bf)
      && /cfg\.stages\[stageKey\]/.test(bf)
      && /return roleFromKey\(stageKey\)/.test(bf));
  }
  // Legacy-pin companyId backfill — makes teammates' pre-scoping pins team-visible.
  const pp = path.join(ROOT, 'scripts/backfill-pins-companyId.js');
  assert('scripts/backfill-pins-companyId.js exists', fs.existsSync(pp));
  if (fs.existsSync(pp)) {
    const bf = read(pp);
    assert('pins backfill is dry-run-by-default + --apply needs --yes',
      /APPLY && !YES/.test(bf) && /--apply --yes/.test(bf));
    assert('pins backfill is idempotent (skips pins with a companyId)',
      /if \(data\.companyId\) \{ alreadyOk\+\+; continue; \}/.test(bf));
    assert('pins backfill derives companyId: linked lead → user map → company claim → own uid',
      /byLead\.has\(data\.leadId\)/.test(bf)
      && /userToCompany\.has\(data\.userId\)/.test(bf)
      && /companyId = claimCid; via = 'claim'/.test(bf)
      && /companyId = data\.userId; via = 'ownUid'/.test(bf));
  }
}

section('Pipelines builder — drag-to-reorder stages');
{
  const pb = read(path.join(ROOT, 'docs/pro/js/pipeline-builder.js'));
  // Draggable grip + drop-target rows carrying view + stage context.
  assert('builder renders a draggable grip per stage row',
    /class="pb-grip" draggable="true"/.test(pb)
    && /class="pb-stage-row" data-view="/.test(pb),
    'expected a draggable .pb-grip inside a .pb-stage-row with data-view/data-stage');
  // Delegated DnD handlers (CSP-safe — no inline ondrag* attributes).
  assert('builder wires delegated dragstart/dragover/drop on the root',
    /addEventListener\('dragstart', onDragStart\)/.test(pb)
    && /addEventListener\('dragover', onDragOver\)/.test(pb)
    && /addEventListener\('drop', onDrop\)/.test(pb),
    'expected delegated drag handlers on the builder root');
  assert('builder has no inline ondrag* handlers (CSP-safe)',
    !/ondragstart=|ondragover=|ondrop=/.test(pb),
    'drag handlers must be delegated, not inline');
  // Reorder is constrained to a single pipeline and splices the working config.
  assert('drop reorders within the same view only',
    /getAttribute\('data-view'\) !== _drag\.view/.test(pb),
    'expected onDragOver to bail when the row is in a different view');
  assert('drop splices the stage into the view order (before/after by pointer)',
    /arr\.splice\(from, 1\)/.test(pb)
    && /arr\.splice\(after \? to \+ 1 : to, 0, payload\.stage\)/.test(pb),
    'expected the dropped stage to be removed then re-inserted at the target');
  // Per-stage hide/show (eye) toggle → config `hidden` flag.
  assert('builder has a hide/show eye toggle writing the hidden flag',
    /data-pb-action="togglehide"/.test(pb)
    && /action === 'togglehide'[\s\S]{0,160}setStageField\(key, 'hidden', !cur\)/.test(pb),
    'expected a togglehide action that flips the stage hidden flag');

  // The board renderer must honour the LIVE (tenant-overridden) config — this
  // was a real end-to-end gap: buildKanbanColumns read module-local consts, so
  // custom views / renames / custom / reordered / hidden stages never showed.
  const boot = read(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'));
  assert('buildKanbanColumns reads window.KANBAN_VIEWS / window.STAGE_META overrides',
    /const VIEWS = window\.KANBAN_VIEWS \|\| KANBAN_VIEWS/.test(boot)
    && /const META = window\.STAGE_META \|\| STAGE_META/.test(boot),
    'expected the board builder to prefer the applied config over the default consts');
  assert('buildKanbanColumns skips stages flagged hidden',
    /\.filter\(k => !\(META\[k\] && META\[k\]\.hidden\)\)/.test(boot),
    'expected hidden stages to be dropped from the rendered columns');
  assert('applyPipelineConfig rebuilds the columns (not just re-renders cards)',
    /window\.buildKanbanColumns\(window\._currentViewKey \|\| vk\)/.test(boot),
    'expected applyPipelineConfig to call buildKanbanColumns so config changes show live');
  // ── Round-2 audit regression guards ──
  assert('applyPipelineConfig restores defaults on an empty config (Reset works without reload)',
    /const hasCfg = raw && typeof raw === 'object'[\s\S]{0,140}Object\.keys\(raw\.stages\)\.length/.test(boot)
    && /resolvePipelineConfig\(hasCfg \? raw : null\)/.test(boot),
    'expected applyPipelineConfig to resolve null (defaults) when there is no real config');
  assert('Reset to defaults force-clears the in-memory config + re-applies',
    /window\._companyProfile\.pipelines = \{\};[\s\S]{0,300}applyPipelineConfig\(\)/.test(pb),
    'expected the reset branch to clear window._companyProfile.pipelines and re-apply');
  assert('buildKanbanColumns never blanks the board (hide-all fallback)',
    /if \(!stages\.length && _all\.length\) stages = _all\.slice\(\)/.test(boot),
    'expected a fallback so hiding every stage does not render zero columns');
  // ── Round-4 audit regression guard ──
  // The builder's eye-toggle writes ov.hidden for custom stages too, but
  // resolvePipelineConfig's custom-stage branch dropped the flag — so a hidden
  // custom column kept rendering (the board filter reads META[k].hidden). The
  // built-in branch already honours ov.hidden; the custom branch must match.
  {
    const stagesSrc = read(path.join(ROOT, 'docs/pro/js/crm-stages.js'));
    assert('resolvePipelineConfig honours hidden for CUSTOM stages (eye-toggle works)',
      /custom: true,[\s\S]{0,400}hidden: ov\.hidden === true,/.test(stagesSrc),
      'expected the custom-stage meta literal to carry hidden: ov.hidden === true so custom stages can be hidden');
  }
  // ── Round-5 audit regression guards ──
  // Hiding a stage removes its column; its leads must NOT be rebucketed into the
  // first column by resolveColumn's viewStages[0] fallback (which would mislabel
  // them, inflate that column's count/$ badges, and let a drag re-stage them).
  // Instead they're partitioned into a `hidden` bucket — single source of truth
  // partitionLeadsByColumn, shared by the board, the chip, and the unit test —
  // and surfaced on the board via the hidden-stage chip, so their count + $ stay
  // visible instead of silently vanishing from the pipeline. (#921 QA follow-up.)
  {
    const stagesSrc = read(path.join(ROOT, 'docs/pro/js/crm-stages.js'));
    assert('partitionLeadsByColumn diverts hidden-stage leads to a `hidden` bucket (no rebucket into first column)',
      /function partitionLeadsByColumn[\s\S]{0,1200}if \(meta\[hk\] && meta\[hk\]\.hidden\) \{ hidden\.push\(l\); return; \}/.test(stagesSrc),
      'expected partitionLeadsByColumn to push a hidden-stage lead to `hidden` and return before resolve() rebuckets it');
    const pipe = read(path.join(ROOT, 'docs/pro/js/crm-pipeline.js'));
    assert('renderLeads collects the hidden-stage leads from partitionLeadsByColumn',
      // Registry read since Globals Tranche 3 T3-C (2026-09-18) — was window.X.
      /_nbdReg\.partitionLeadsByColumn\(list, stageKeys[\s\S]{0,240}_hiddenStageLeads = _part\.hidden/.test(pipe),
      'expected renderLeads to bucket via partitionLeadsByColumn and keep _part.hidden');
    assert('renderLeads surfaces hidden-stage leads via the chip instead of silently dropping them',
      /renderHiddenStageChip\(_hiddenStageLeads\)/.test(pipe)
      && /function renderHiddenStageChip\(leads\)/.test(pipe),
      'expected renderLeads to pass the hidden leads to renderHiddenStageChip');
  }
  // The kanban stage label is tenant-config text rendered into board.innerHTML —
  // escape it (defence-in-depth behind the prod CSP).
  assert('kanban stage label is HTML-escaped before board.innerHTML',
    /const _escLbl = window\.nbdEsc \|\|[\s\S]{0,400}const label = _escLbl\(meta\.label \|\| stageKey\);/.test(boot),
    'expected buildKanbanColumns to escape the tenant-controlled stage label');
  assert('_saveLeadCoords does not bump updatedAt (passive backfill)',
    /updateDoc\(doc\(db,'leads',id\), \{ lat, lng \}\)/.test(boot)
    && !/updateDoc\(doc\(db,'leads',id\), \{ lat, lng, updatedAt/.test(boot),
    'expected _saveLeadCoords to write only lat/lng, no updatedAt');
  // Backfill hardening
  const stageRoleBf = read(path.join(ROOT, 'scripts/backfill-lead-stageRole.js'));
  assert('stageRole backfill checks the tenant override via normalized key too',
    /\bnormKey\b[\s\S]{0,40}require\('\.\.\/functions\/stage-roles'\)/.test(stageRoleBf)
    && /cfg\.stages\[stageKey\] \|\| \(nk !== stageKey \? cfg\.stages\[nk\]/.test(stageRoleBf),
    'expected resolveRole to try cfg.stages[normKey(stage)] before the key map');
  const pinsBf = read(path.join(ROOT, 'scripts/backfill-pins-companyId.js'));
  assert('pins backfill skips ambiguous multi-company users (no wrong-tenant guess)',
    /if \(hist\.size > 1\) ambiguousUsers\.add\(uid\)/.test(pinsBf)   // flags multi-company users
    && /} else if \(ambiguousUsers\.has\(data\.userId\)\) \{/.test(pinsBf) // skip branch before the user-map guess
    && /ambiguous\+\+;/.test(pinsBf),
    'expected leadless pins of multi-company users to be skipped, not guessed');
  // A company rep who door-knocked but never created a lead is absent from the
  // leads-book maps, so the ownUid fallback would mis-stamp companyId = uid and
  // their leadless pins would fail the /pins sameCompanyAsResource() read rule
  // (invisible to the team). Resolve their real tenant from the companyId custom
  // claim (admin auth) before falling back to uid.
  assert('pins backfill resolves a leadless company rep via their companyId claim before the uid fallback',
    /const claimCid = await claimCompanyFor\(data\.userId\)/.test(pinsBf)  // claim lookup in the else branch
    && /u\.customClaims && u\.customClaims\.companyId/.test(pinsBf)         // reads the companyId claim via admin auth
    && /if \(claimCid\) \{[\s\S]{0,120}via = 'claim'/.test(pinsBf),        // uses the claim before ownUid
    'expected a leadless company rep\'s pins to be stamped with their claim companyId, not their uid');
}

section('Review engine — role-aware nudges, tenant-safe copy, Settings-sourced link');
{
  const rev = read(path.join(ROOT, 'docs/pro/js/review-engine.js'));

  // Won detection is role-based: persisted stageRole wins, isWonStage covers
  // key classification. The old hardcoded closedStages allowlist missed
  // final_payment/final_photos/deductible_collected and custom won stages —
  // it must not come back.
  assert('review nudge classifies won by persisted stageRole, then isWonStage',
    /l\.stageRole \|\| l\._stageRole/.test(rev)
    && /window\.isWonStage/.test(rev)
    && !/const closedStages\s*=/.test(rev),
    'expected isWonLead(stageRole → isWonStage) and no hardcoded closedStages list');

  // Recency keys off entering the won stage — updatedAt resets on any edit.
  assert('review nudge recency uses stageStartedAt (updatedAt fallback only)',
    /l\.stageStartedAt \|\| l\.updatedAt/.test(rev));

  // Review link resolves from the SAME Settings field the homeowner portal
  // reads, and the deep-merged NBD /r default never leaks to another tenant.
  assert('review link prefers users/{uid}.googleReviewUrl over legacy localStorage',
    /googleReviewUrl/.test(rev)
    && /nobigdealwithjoedeal\.com\/r/.test(rev)
    && /!== NBD_DEFAULT_REVIEW_URL \|\| \(b\.seal \|\| ''\) === 'NBD'/.test(rev),
    'expected getReviewLink: Settings field first + NBD-default leak guard');

  // Copy surfaces resolve the tenant brand, not NBD literals (TenantContext
  // Phase B). The BRAND const may remain only as the no-profile fallback.
  assert('review SMS/email copy resolves window._brand() (tenant-safe)',
    /window\._brand/.test(rev)
    && /brandName\(\)/.test(rev)
    && /brandSignOff\(\)/.test(rev)
    && !/Joe & the No Big Deal team/.test(rev),
    'expected brandName()/brandSignOff() in message bodies, no hardcoded NBD sign-off');

  // The senders await the async link resolution — a bare sync read would
  // silently revert to the legacy localStorage-only behavior.
  assert('review senders are async and await getReviewLink()',
    /async function sendReviewRequestSMS/.test(rev)
    && /async function sendReviewRequestEmail/.test(rev)
    && /await getReviewLink\(\)/.test(rev));

  // Referral surfaces (NBD-leak audit 2026-07-29): a nameless lead (Quick Add
  // creates firstName:'' by design; non-Latin names sanitize to '') must not
  // get an NBD-prefixed code on a tenant's surface, and the referral SMS must
  // resolve the tenant brand like every other copy surface in this file.
  assert('referral code prefix fallback is isNbd-gated (REF for tenants)',
    /_isNbdBrand\(\) \? 'NBD' : 'REF'/.test(rev)
    && !/lead\.firstName \|\| 'NBD'/.test(rev),
    "expected _fbPrefix = _isNbdBrand() ? 'NBD' : 'REF', no bare || 'NBD'");
  assert('referral SMS resolves brandName(), not the BRAND const',
    !/choosing \$\{BRAND\.name\}/.test(rev)
    && /choosing \$\{brandName\(\)\}/.test(rev));
}

section('Team visibility: lead-activity notes readable across the lead (rules + client)');
{
  const rules = read(path.join(ROOT, 'firestore.rules'));
  // lastIndexOf → the TOP-LEVEL /notes match (the subcollection one is earlier).
  const notesBlock = rules.slice(rules.lastIndexOf('match /notes/'),
                                rules.lastIndexOf('match /notes/') + 700);
  // Read is scoped to the PARENT LEAD (owner or same-company), not the note
  // author — so a lead owner sees a manager's stage-change note on their lead.
  assert('top-level /notes read is scoped to the parent lead (owner or same-company)',
    /allow read:[\s\S]{0,260}leads\/\$\(resource\.data\.leadId\)[\s\S]{0,140}parentLeadInMyCompany\(resource\.data\.leadId\)/.test(notesBlock));
  // 2026-09-25 (Jo's decision B): the author must also not be a viewer.
  assert('/notes update+delete stay author-only (and never a viewer)',
    /allow update, delete:\s*if \(isOwner\(resource\.data\.userId\) && notViewer\(\)\) \|\| isAdmin\(\);/.test(notesBlock));

  // Client: timeline + report note reads query by leadId ONLY (no author
  // filter), so teammates' notes appear; the rule authorizes it.
  const cust = read(path.join(ROOT, 'docs/pro/js/customer-bootstrap.module.js'));
  assert('customer timeline reads notes by leadId only (no userId filter)',
    /collection\(window\.db, 'notes'\), where\('leadId', '==', leadId\)\)/.test(cust) &&
    !/collection\(window\.db, 'notes'\), where\('leadId', '==', leadId\), where\('userId'/.test(cust));
  const rpt = read(path.join(ROOT, 'docs/pro/js/customer-photo-report-generator.js'));
  assert('notes panel reads by leadId only (no userId filter)',
    /collection\(db, 'notes'\), where\('leadId', '==', leadId\)\)/.test(rpt) &&
    !/collection\(db, 'notes'\), where\('leadId', '==', leadId\), where\('userId'/.test(rpt));
}

section('Customer page: invoices load (team-scope + createdAt sort)');
{
  const src = read(path.join(ROOT, 'docs/pro/js/customer-tasks-ui.js'));
  const fn = src.slice(src.indexOf('window.loadInvoices ='),
                       src.indexOf('window.loadInvoices =') + 5400);
  // The old orderBy('date') dropped every invoice (docs are stamped createdAt,
  // never date). Must NOT re-introduce that field sort in the query. (Targets
  // the window.orderBy(...) call form so a code comment mentioning the old bug
  // doesn't trip it.)
  assert('loadInvoices no longer queries orderBy(date)',
    !/window\.orderBy\(\s*['"]date['"]/.test(fn));
  // Team readers (company_admin/manager/viewer + companyId) read by
  // leadId+companyId; everyone else by leadId+createdBy — mirrors the
  // /invoices rule + loadCommunicationLog.
  assert('loadInvoices is team-scoped (companyId) with an owner fallback (createdBy)',
    /where\(\s*['"]companyId['"]\s*,\s*['"]==['"]\s*,\s*companyId\)/.test(fn) &&
    /where\(\s*['"]createdBy['"]\s*,\s*['"]==['"]\s*,\s*uid\)/.test(fn));
  // Results are sorted newest-first by createdAt in JS (no composite index).
  assert('loadInvoices sorts by createdAt client-side',
    /\.sort\(\([\s\S]{0,80}createdAt/.test(fn));
}

section('Photo modal: _getPhotos is team-scoped (badge vs gallery parity)');
{
  const src = read(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'));
  const fn = src.slice(src.indexOf('async function _getPhotos(leadId)'),
                       src.indexOf('async function _getPhotos(leadId)') + 1400);
  // The modal path was userId-only while the badge/_photoCache read dual-scope,
  // so managers saw a count then an empty gallery. Must now add the companyId
  // scope for company readers, deduped, mirroring _photoCache.
  assert('_getPhotos adds a companyId scope for company readers',
    /\['company_admin','manager','viewer'\]\.includes\(claims\.role/.test(fn) &&
    /where\(\s*['"]companyId['"]\s*,\s*['"]==['"]\s*,\s*claims\.companyId\)/.test(fn));
  assert('_getPhotos still queries by leadId and dedupes by doc id',
    /where\(\s*['"]leadId['"]\s*,\s*['"]==['"]\s*,\s*leadId\)/.test(fn) &&
    /seen\.has\(d\.id\)/.test(fn));
}

section('Pipeline small fixes (#9 legacy card handlers, #10 filter preserved)');
{
  const crm = read(path.join(ROOT, 'docs/pro/js/crm-pipeline.js'));
  // #10 — "Show all N" preserves the active search/damage filter instead of
  // repainting the whole book unfiltered.
  assert('show-all expander preserves the active filter',
    /_kbShowAll\[stageKey\] = true;[\s\S]{0,400}renderLeads\(window\._leads, window\._filteredLeads\)/.test(crm));
  // #9 — the legacy kanban fallback now wires card handlers (was drag-only).
  const legacy = crm.slice(crm.indexOf('LEGACY FALLBACK'), crm.indexOf('LEGACY FALLBACK') + 2800);
  assert('legacy kanban fallback wires card listeners (not just drag)',
    /renderColumnCards\(body, cards, stage\);[\s\S]{0,450}wireKanbanCardListeners\(body\)/.test(legacy));
  // (#11 — homeowner-share badge dispatch — is covered in portal.test.js.)
  // #12 — the overdue-followup count skips won/lost/job by stageRole, so a won
  // deal at final_payment (or a custom won/lost stage) no longer nags "due".
  const overdue = crm.slice(crm.indexOf('Follow-up overdue'), crm.indexOf('Follow-up overdue') + 800);
  assert('overdue-followup excludes won/lost/job by stageRole',
    /window\.stageRole\(sk\)/.test(overdue) &&
    /role === 'won' \|\| role === 'lost' \|\| role === 'job'/.test(overdue));
}

section('Swallowed-error fixes: doc-save + task-toggle tell the truth');
{
  // #7 — a generated doc that fails to attach to the lead must NOT show a
  // success toast. onSave surfaces an honest "NOT saved to the customer" error
  // when persistence was attempted but the metadata write never landed.
  const docgen = read(path.join(ROOT, 'docs/pro/js/document-generator.js'));
  const onSave = docgen.slice(docgen.indexOf('onSave: async'),
                             docgen.indexOf('onSave: async') + 1600);
  assert('doc onSave surfaces an error when the doc did not attach to the lead',
    /attemptedPersist && !attachedToLead[\s\S]{0,200}NOT saved to the customer/.test(onSave) &&
    /'error'\)/.test(onSave));

  // #8 — a failed task toggle must toast an error AND revert the checkbox by
  // reloading the timeline from Firestore (the box flipped optimistically).
  const tasks = read(path.join(ROOT, 'docs/pro/js/customer-tasks-ui.js'));
  const toggle = tasks.slice(tasks.indexOf('window.toggleTask ='),
                             tasks.indexOf('window.toggleTask =') + 1600);
  assert('toggleTask failure toasts an error + reverts via loadTimeline',
    /catch \(error\)[\s\S]{0,500}showToast\([\s\S]{0,80}Could not update task/.test(toggle) &&
    /catch \(error\)[\s\S]{0,700}loadTimeline\(window\._customerId/.test(toggle));
}

section('Claim unification: ClaimCore canonical view + synced status + Claim Details panel');
{
  const core = read(path.join(ROOT, 'docs/pro/js/claim-core.js'));
  const ic   = read(path.join(ROOT, 'docs/pro/js/insurance-claim.js'));
  const cb   = readCustomer();
  const boot = read(path.join(ROOT, 'docs/pro/js/customer-bootstrap.module.js'));
  const html = read(path.join(ROOT, 'docs/pro/customer.html'));

  // ── Behavioral: execute claim-core.js in a VM and probe the API. ──
  // A window stub is all it needs (the parse-time self-render guard
  // short-circuits on window._currentLead being undefined).
  const vm = require('vm');
  const sandbox = { window: {} };
  let vmOk = true, vmErr = null;
  try { vm.runInNewContext(core, sandbox); } catch (e) { vmOk = false; vmErr = e; }
  assert('claim-core.js executes standalone against a bare window stub' + (vmErr ? ` (${vmErr.message})` : ''), vmOk);
  const CC = sandbox.window.ClaimCore;
  const ELEVEN = ['initial_inspection','documentation','claim_filed','adjuster_scheduled',
                  'adjuster_visit','estimate_review','supplement_filed','approved',
                  'work_scheduled','completed','denied'];
  assert('every one of the 11 workflow stages maps to one of the 7 dropdown statuses',
    !!CC && ELEVEN.every(s => CC.STATUS_VALUES.includes(CC.claimStatusFromStage(s))));
  assert('normalizeClaim resolves carrier from insCarrier over legacy insuranceCarrier',
    !!CC && CC.normalizeClaim({ insuranceCarrier: 'Allstate' }).carrier === 'Allstate'
         && CC.normalizeClaim({ insCarrier: 'State Farm', insuranceCarrier: 'Allstate' }).carrier === 'State Farm');
  assert('normalizeClaim resolves deductible from deductibleOrOwedByHO over legacy deductible',
    !!CC && CC.normalizeClaim({ deductible: 900 }).deductible === 900
         && CC.normalizeClaim({ deductibleOrOwedByHO: 500, deductible: 900 }).deductible === 500);
  // The old widget wrote claimStatus:'in_progress' — not a dropdown value.
  // normalizeClaim must recover a corrupted status from the stage instead
  // of parroting it back.
  assert('normalizeClaim recovers a corrupted claimStatus from claimStage',
    !!CC && CC.normalizeClaim({ claimStatus: 'in_progress', claimStage: 'approved' }).status === 'Approved'
         && CC.normalizeClaim({ claimStatus: 'in_progress' }).status === 'No Claim');

  // ── The status-corruption fix itself. ──
  assert('advanceClaimStage no longer hardcodes claimStatus:\'in_progress\'',
    !/claimStatus:\s*['"]in_progress['"]/.test(ic));
  assert('advanceClaimStage syncs claimStatus via ClaimCore.claimStatusFromStage (omits when unavailable)',
    /ClaimCore\.claimStatusFromStage\)\s*\?\s*window\.ClaimCore\.claimStatusFromStage\(nextStageId\)\s*:\s*null/.test(ic)
    && /\.\.\.\(syncedStatus \? \{ claimStatus: syncedStatus \} : \{\}\)/.test(ic));
  assert('workflow widget reads insCarrier/deductibleOrOwedByHO with legacy fallbacks',
    /insuranceCarrier:\s*lead\.insCarrier \|\| lead\.insuranceCarrier/.test(ic)
    && /lead\.deductibleOrOwedByHO != null[\s\S]{0,120}:\s*lead\.deductible/.test(ic));
  assert('advancing the workflow refreshes the Claim Details panel',
    /ClaimPanel\.refresh\)window\.ClaimPanel\.refresh\(\)/.test(ic));

  // ── Panel + editor wiring (CSP: delegate actions, zero inline handlers). ──
  assert('claim-core.js contains no inline event handlers',
    !/\son[a-z]+\s*=\s*["']/i.test(core));
  assert('panel renders Edit + contact slots through the customer data-action delegate',
    /data-action="openClaimEditor"/.test(core)
    && /data-action="saveClaimEdits"/.test(core)
    && /data-action="closeClaimEditor"/.test(core));
  assert('contact slots render tap-to-call/text/email links',
    /href="tel:/.test(core) && /href="sms:/.test(core) && /href="mailto:/.test(core));
  assert('editor saves contact-slot fields flat on the lead (types.js adjuster* convention)',
    /adjusterName:\s*val\('clmAdjName'\)/.test(core)
    && /claimHandlerName:\s*val\('clmHandlerName'\)/.test(core)
    && /mortgageCompanyName:\s*val\('clmMortgageName'\)/.test(core)
    && /dateDiscovered:\s*val\('clmDateDiscovered'\)/.test(core)
    && /policyHolder:\s*val\('clmPolicyHolder'\)/.test(core));

  // ── customer.html: load order + shell panel. ──
  assert('claim-core.js loads before insurance-claim.js (status sync needs ClaimCore at advance time)',
    html.indexOf('js/claim-core.js') !== -1
    && html.indexOf('js/claim-core.js') < html.indexOf('js/insurance-claim.js'));
  assert('static insurance info-grid is gone — #insurancePanel is a ClaimPanel shell',
    !/id="infoClaimNumber"/.test(html) && /id="insurancePanel"/.test(html));
  assert('customer-bootstrap renders the panel via ClaimPanel and shows it on any live claimStatus',
    /ClaimPanel\?\.render/.test(boot)
    && /lead\.claimStatus && lead\.claimStatus !== 'No Claim'/.test(boot));

  // ── V2 builder: claim inputs + prefill + write-back. ──
  const v2 = read(path.join(ROOT, 'docs/pro/js/estimate-v2-ui.js'));
  assert('V2 claim section gains Date of Loss + Policy Number inputs (data-claim bound)',
    /id="v2claimDateOfLoss" data-claim="dateOfLoss"/.test(v2)
    && /id="v2claimPolicyNumber" data-claim="policyNumber"/.test(v2));
  assert('syncCustomerInputs mirrors the two new claim fields',
    /v2claimDateOfLoss:\s*state\.claim && state\.claim\.dateOfLoss/.test(v2)
    && /v2claimPolicyNumber:\s*state\.claim && state\.claim\.policyNumber/.test(v2));
  assert('prefillFromLead fills policy/date-of-loss/adjuster only when state is empty',
    /lead\.policyNumber && !state\.claim\.policyNumber/.test(v2)
    && /lead\.dateOfLoss && !state\.claim\.dateOfLoss/.test(v2)
    && /lead\.adjusterName && !state\.claim\.adjuster/.test(v2));
  // 2026-09-25 (deposit rule): the $2,500 placeholder is gone — unset is null
  // (or a cleared 0); 2500 stays recognised for drafts saved with it.
  assert('prefillFromLead only fills an unset deductible (null / cleared 0 / the retired 2500 placeholder)',
    /state\.claim\.deductible == null \|\| state\.claim\.deductible === 0 \|\| state\.claim\.deductible === 2500/.test(v2)
    && /deductible: null, acv: null, recoverableDepreciation: null, policyNumber: ''/.test(v2));
  const dbboot = read(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'));
  assert('_saveEstimate claim write-back fills ONLY empty lead fields (CRM record wins)',
    /estClaim\.carrier && !lead\.insCarrier && !lead\.insuranceCarrier/.test(dbboot)
    && /estClaim\.number && !lead\.claimNumber/.test(dbboot)
    && /estClaim\.adjuster && !lead\.adjusterName/.test(dbboot)
    && /Object\.keys\(claimBack\)\.length\) await updateDoc\(leadRef, claimBack\)/.test(dbboot));
}

section('Count badges: customer-page modules print their numbers (RoofLink "Photos (16)")');
{
  const tasksUi = read(path.join(ROOT, 'docs/pro/js/customer-tasks-ui.js'));
  const gen     = read(path.join(ROOT, 'docs/pro/js/customer-photo-report-generator.js'));
  const boot    = read(path.join(ROOT, 'docs/pro/js/customer-bootstrap.module.js'));
  const html    = readCustomer();
  // The documents count moved out of customer-photo-report-generator.js with
  // the 2026-08-18 documents consolidation (see customer-documents.js header).
  const docsStore = read(path.join(ROOT, 'docs/pro/js/customer-documents.js'));

  // Helpers: window-exposed (cross-module callers), zero hides, 99+ cap.
  assert('nbdNavCount + nbdTitleCount exposed on window with zero-hides + 99+ cap',
    /window\.nbdNavCount = function \(badgeId, n\)/.test(tasksUi)
    && /n > 99 \? '99\+' : String\(n\)/.test(tasksUi)
    && /window\.nbdTitleCount = function \(titleId, base, n\)/.test(tasksUi)
    && /n > 0 \? base \+ ' \(' \+ n \+ '\)' : base/.test(tasksUi));

  // Markup: jump-nav badge spans + the seven counted panel titles.
  assert('jump-nav carries Photos/Documents/Timeline count chips',
    /id="navCountPhotos"/.test(html) && /id="navCountDocs"/.test(html) && /id="navCountTasks"/.test(html));
  assert('panel titles carry ids for count stamping',
    ['photosPanelTitle', 'docsPanelTitle', 'estimatesPanelTitle', 'notesPanelTitle',
     'projectPhotosTitle', 'invoicesPanelTitle', 'commsPanelTitle']
      .every(id => html.includes('id="' + id + '"')));

  // Loaders stamp their counts on the data they already fetched.
  assert('updatePhotoStats stamps the nav chip + both photo titles',
    /nbdNavCount\('navCountPhotos', photos\.length\)/.test(tasksUi)
    && /nbdTitleCount\('projectPhotosTitle', 'Project Photos', photos\.length\)/.test(tasksUi)
    && /nbdTitleCount\('photosPanelTitle', 'Photos', photos\.length\)/.test(tasksUi));
  assert('invoices + comms loaders stamp their panel titles',
    /nbdTitleCount\('invoicesPanelTitle', 'Invoices & Payments', invoices\.length\)/.test(tasksUi)
    && /nbdTitleCount\('commsPanelTitle', 'Recent Communications', comms\.length\)/.test(tasksUi));
  assert('notes loader stamps its count (typeof-guarded — script order varies)',
    /typeof window\.nbdTitleCount === 'function'[\s\S]{0,120}notesPanelTitle', 'Notes', notes\.length/.test(gen));
  // Both documents counts now come off the ONE merged list the store holds.
  // They used to be stamped from a query against a collection none of the
  // page's three document writers wrote to, so a customer with a stack of
  // generated contracts got no badge and an empty panel.
  // The panel is labelled "Files" (2026-09-06). The label lives in TWO places
  // — the markup in customer.html and this runtime repaint — so the literal is
  // pinned here: changing only the HTML would look right until the first load
  // silently stamped "Documents" back over it.
  assert('the documents store stamps the nav chip + panel title from the merged list',
    /nbdNavCount\('navCountDocs', docs\.length\)/.test(docsStore)
    && /nbdTitleCount\('docsPanelTitle', 'Files', docs\.length\)/.test(docsStore));
  assert('the stale documents count is gone from the photo-report module',
    !/navCountDocs/.test(gen));
  // Feature 6 tightened the filter: Add-Event entries (type:'event') live
  // in the same subcollection but are milestones, not todos.
  assert('timeline stamps OPEN-task count on the nav (done tasks + events excluded)',
    /nbdNavCount\('navCountTasks',\s*\n?\s*taskSnap\.docs\.filter\(d => \{ const t = d\.data\(\) \|\| \{\}; return !t\.done && t\.type !== 'event'; \}\)\.length\)/.test(boot));
  assert('estimates loader stamps its panel title from the soft-delete-filtered list',
    /nbdTitleCount\('estimatesPanelTitle', 'Estimates', window\._customerEstimates\.length\)/.test(boot));
}

section('Cover photo: Set Cover action + hero, cover-first consumers');
{
  const tasksUi = read(path.join(ROOT, 'docs/pro/js/customer-tasks-ui.js'));
  const boot    = read(path.join(ROOT, 'docs/pro/js/customer-bootstrap.module.js'));
  const widgets = read(path.join(ROOT, 'docs/pro/js/dashboard-widgets.js'));
  const pipe    = read(path.join(ROOT, 'docs/pro/js/crm-pipeline.js'));
  const v2      = read(path.join(ROOT, 'docs/pro/js/estimate-v2-ui.js'));
  const html    = readCustomer();
  const types   = read(path.join(ROOT, 'docs/pro/js/types.js'));

  // Persistence contract: flat lead fields, id + denormalized URL.
  assert('setCoverPhotoFromPopup persists coverPhotoId + coverPhotoUrl and toggles off on re-tap',
    /window\.setCoverPhotoFromPopup = async function \(idx\)/.test(tasksUi)
    && /coverPhotoId: photo\.id, coverPhotoUrl: photo\.url/.test(tasksUi)
    && /coverPhotoId: null, coverPhotoUrl: null/.test(tasksUi)
    && /lead\.coverPhotoId === photo\.id/.test(tasksUi));
  assert('lead typedef declares coverPhotoId/coverPhotoUrl',
    /@property \{string=\} coverPhotoId/.test(types) && /@property \{string=\} coverPhotoUrl/.test(types));

  // Quick-edit popup carries the Set Cover button with live state.
  assert('photo quick-edit popup renders the Set Cover toggle',
    /data-action="setCoverPhotoFromPopup"/.test(tasksUi)
    && /★ Cover Photo — tap to clear/.test(tasksUi)
    && /☆ Set as Cover Photo/.test(tasksUi));

  // Hero on the customer page — https-guarded renderer + bootstrap call.
  assert('customer.html has the #coverHero band and bootstrap renders it (typeof-guarded)',
    /id="coverHero"/.test(html)
    && /function renderCoverHero\(url\)/.test(tasksUi)  // registry-only since T3-C (2026-09-18)
    && /\/\^https\?:\/i\.test\(String\(url\)\)/.test(tasksUi)
    && /renderCoverHero\(lead\.coverPhotoUrl \|\| null\)/.test(boot));

  // Consumers prefer the cover.
  assert('mobile job-detail hero prefers lead.coverPhotoUrl (https-guarded) over first photo',
    /lead\.coverPhotoUrl && \/\^https\?:\/i\.test\(String\(lead\.coverPhotoUrl\)\)/.test(widgets));
  assert('kanban thumb strip leads with the cover, deduped',
    /\[\{ url: l\.coverPhotoUrl \}, \.\.\.photos\.filter\(p => p\.url !== l\.coverPhotoUrl\)\]/.test(pipe));
  assert('V2 PDF payload fronts the lead cover instead of hardcoded null',
    !/coverPhoto:\s*null,/.test(v2)
    && /lead && lead\.coverPhotoUrl/.test(v2));
}

section('Task unification + Add Event + Job Checklist (RoofLink parity, feature 6)');
{
  const tasksUi = read(path.join(ROOT, 'docs/pro/js/customer-tasks-ui.js'));
  const boot    = read(path.join(ROOT, 'docs/pro/js/customer-bootstrap.module.js'));
  const chk     = read(path.join(ROOT, 'docs/pro/js/customer-checklist.js'));
  const html    = readCustomer();
  const m006    = read(path.join(ROOT, 'functions/migrations/scripts/006-unify-tasks.js'));

  // ── Unification: ONE canonical store, leads/{leadId}/tasks. ──
  assert('saveTask writes to the subcollection and mirrors title→text (dashboard renders t.text)',
    /addDoc\(window\.collection\(window\.db, 'leads', window\._customerId, 'tasks'\)/.test(tasksUi)
    && /title: title,\s*\n\s*text: title,/.test(tasksUi));
  assert('toggleTask updates the subcollection doc',
    /updateDoc\(window\.doc\(window\.db, 'leads', window\._customerId, 'tasks', taskId\)/.test(tasksUi));
  assert('customer page no longer writes the legacy top-level tasks collection',
    !/addDoc\(window\.collection\(window\.db, 'tasks'\)/.test(tasksUi));
  assert('both bootstrap timelines read the subcollection with title||text fallback',
    /collection\(db, 'leads', leadId, 'tasks'\)/.test(boot)
    && /collection\(window\.db, 'leads', leadId, 'tasks'\)/.test(boot)
    && !/collection\(db, 'tasks'\)/.test(boot)
    && !/collection\(window\.db, 'tasks'\)/.test(boot)
    && /task\.title \|\| task\.text \|\| 'Task'/.test(boot));

  // ── Add Event: dated 📅 milestones in the same store, no new rules. ──
  assert('event modal markup + open/save wired through the delegate',
    /id="eventModal"/.test(tasksUi) && /id="eventTitle"/.test(tasksUi) && /id="eventWhen"/.test(tasksUi)
    && /window\.openEventModal = function/.test(tasksUi)
    && /window\.saveEvent = async function/.test(tasksUi));
  assert('saveEvent stores type:event with ISO eventAt + manual source in the subcollection',
    /type: 'event',/.test(tasksUi)
    && /eventAt: new Date\(when\)\.toISOString\(\)/.test(tasksUi)
    && /source: 'manual',/.test(tasksUi));
  assert('customer.html has the 📅 Add Event button',
    /data-action="openEventModal"/.test(html));
  assert('timeline renders events as 📅 and excludes them from the open-task badge',
    /task\.type === 'event'/.test(boot)
    && /!t\.done && t\.type !== 'event'/.test(boot));
  assert('Cal.com appointments merge into the timeline (leadId+userId scoped, startTime required)',
    /collection\(db, 'appointments'\), where\('leadId', '==', leadId\), where\('userId', '==', uid0\)/.test(boot)
    && /a\.startTime\?\.toDate/.test(boot));

  // ── Job Checklist: persisted check-off state on the lead. ──
  assert('customer-checklist.js ships insurance + default lists under stable keys',
    /window\.JobChecklist = \{ render: render, CHECKLISTS: CHECKLISTS \}/.test(chk)
    && /ins-file-claim/.test(chk) && /ins-supplement/.test(chk)
    && /job-collect/.test(chk) && /NEVER rename/.test(chk));
  assert('checkboxes ride the existing change delegate (CSP-safe)',
    /data-change-action="toggleJobChecklistItem" data-arg="/.test(chk)
    && /data-pass-el="true"/.test(chk)
    && !/\son[a-z]+\s*=\s*["']/i.test(chk));
  assert('toggle persists via dot-path map update and reverts the box on failure',
    /update\['jobChecklist\.' \+ key\] = checked/.test(chk)
    && /el\.checked = !checked/.test(chk));
  assert('customer.html hosts #checklistPanel + loads the module; bootstrap renders it',
    /id="checklistPanel"/.test(html)
    && /js\/customer-checklist\.js/.test(html)
    && /JobChecklist\?\.render/.test(boot));

  // ── Migration 006 heals the backlog. ──
  assert('006 exists as version 6 (unify-tasks) with the runner contract',
    /exports\.version\s*=\s*6/.test(m006)
    && /exports\.name\s*=\s*'unify-tasks'/.test(m006)
    && /exports\.up = async \(ctx\)/.test(m006));
  assert('006 copies to the SAME doc id (idempotent) and never deletes originals',
    /db\.doc\('leads\/' \+ leadId \+ '\/tasks\/' \+ d\.id\)/.test(m006)
    && /migratedToSubcollection: true/.test(m006)
    && !/\.delete\(/.test(m006));
  assert('006 mirrors title<->text and writes an audit report',
    /const label = t\.title \|\| t\.text \|\| 'Task'/.test(m006)
    && /system\/migrations\/reports\/006-unify-tasks/.test(m006));
}

section('QA wiring audit: photo Reorder button binds in module scope (not window delegate)');
{
  // customer.html's delegate resolves data-action names on WINDOW
  // (customer-tasks-ui.js), but the Tranche-1 globals cleanup made
  // toggleCustomerPhotoReorder module-local — and a tripwire test bans
  // re-windowing it. The old data-action button therefore console.error'd
  // and did nothing: a dead Reorder button on every customer gallery.
  // Contract now: NO data-action on the button; the photo-strip click
  // delegate routes #nbdReorderToggle to the module-local function.
  const cb = readCustomer();
  assert('Reorder button carries no data-action (window path is banned)',
    !/data-action="toggleCustomerPhotoReorder"/.test(cb)
    && /id="nbdReorderToggle">Reorder<\/button>/.test(cb));
  assert('photo-strip click delegate routes the Reorder toggle in module scope',
    /closest\('#nbdReorderToggle'\)\)\s*\{\s*toggleCustomerPhotoReorder\(\);/.test(cb));
}

section('Add-lead: no false "Lead saved!" + visible validation errors (2026-09-02)');
{
  // _saveLead returns null on three deliberate non-writes — the Lite
  // lead cap, the billing gate's upgrade modal, and the dedup prompt's
  // cancel / open-existing — each of which shows its own feedback.
  // saveLead used to fall through to "Lead saved!" + closeLeadModal
  // regardless. Separately, #mErr renders at the TOP of a modal whose
  // Save button is ~230 lines of markup lower, so on a phone the
  // name/address error was off-screen (CRM-ADDRESS-INTEGRITY 2026-08-18
  // observed this live as a "silent" failure).
  const leads = read(path.join(ROOT, 'docs/pro/js/crm-leads.js'));
  const bailIdx  = leads.indexOf('if (_wasNewLead && !_savedId) return;');
  const savedIdx = leads.indexOf("mOk.textContent='Lead saved!'");
  assert('saveLead bails before "Lead saved!" when _saveLead aborted a new lead',
    bailIdx > -1 && savedIdx > -1 && bailIdx < savedIdx,
    'expected the null-return guard to precede the success line');
  assert('the abort guard runs before _modalIntel is cleared (retry keeps parcel data)',
    /if \(_wasNewLead && !_savedId\) return;\s*\n\s*window\._modalIntel = null;/.test(leads));
  assert('validation errors scroll #mErr into view and toast',
    /const showFormError = \(msg, focusEl\) =>/.test(leads)
    && /mErr\.scrollIntoView\(/.test(leads)
    && /showToast\(msg, 'error'\)/.test(leads));
  for (const msg of ['Name and address required.', 'Email looks invalid', 'Phone needs at least 10 digits.']) {
    const esc = msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert('"' + msg + '" routes through showFormError',
      new RegExp("showFormError\\('" + esc).test(leads));
  }
}

};
