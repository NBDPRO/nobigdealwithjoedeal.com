/* portal-share-recording.test.js
 *
 * Every portal-share entry point must reach PortalLinkHelpers.recordShare.
 *
 * portal-link-helpers.js says so in its own export block: "Every share entry
 * point must reach this function or downstream features (W57 fresh pulse, W58
 * viewed badge, W92 engagement tier, W112 smart followup, stale-shares filter)
 * silently see zero signal." Three of the four controls in
 * customer-gallery-share.js did not — including the customer page's two
 * PRIMARY buttons, Copy Portal Link and Text Portal Link.
 *
 * They resolve through PortalLinkHelpers.resolveUrl, which deliberately does
 * NOT record (only copyForLead / smsForLead do), and these handlers
 * reimplement those flows rather than calling them so they can drive their own
 * button-label states. Every other surface in the app records:
 * dashboard-api.js:517, dashboard-actions.js:1518, job-templates-ui.js:1983.
 *
 * Live consequence: a rep works the deal from the customer page, texts the
 * homeowner a working link, and the CRM goes on insisting the link was never
 * sent — smart-followup keeps saying "send portal link", the lead never leaves
 * the stale-shares / never-shared views, and the "last shared" chip on that
 * same page stays empty.
 *
 * This suite RUNS the real handlers in a vm against a DOM stub rather than
 * grepping for the call, so a future refactor that keeps the string but breaks
 * the flow still fails. It also pins WHEN recording happens: on a confirmed
 * copy, not on the "press Ctrl+C" fallback, matching the shared helper.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('docs/pro/js/customer-gallery-share.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── a DOM/browser stub just wide enough to run the real file ── */
function load(opts) {
  opts = opts || {};
  const recorded = [];
  const toasts = [];
  const minted = [];
  const els = {};
  const mkEl = () => ({
    value: '', innerHTML: '', disabled: false, style: {},
    focus() {}, select() {},
  });
  ['quickCopyPortalBtn', 'quickSmsPortalBtn', 'quickEmailPortalBtn',
    'quickPreviewPortalBtn', 'fullPortalUrl', 'gallerySharePanel'].forEach((id) => {
    els[id] = mkEl();
  });

  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout,
    document: {
      getElementById: (id) => els[id] || null,
      createElement: () => ({
        style: {}, value: '', focus() {}, select() {},
      }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => !!opts.execCommandWorks,
    },
    navigator: {
      clipboard: opts.noClipboardApi ? undefined : {
        writeText: async () => {
          if (opts.clipboardFails) throw new Error('NotAllowedError');
        },
      },
    },
    showToast: (msg, type) => { toasts.push([type, msg]); },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.location = { href: '' };
  ctx.window._customerId = 'lead-123';
  // R6-3-2 (2026-10-07): Text Portal asks the server's "ok to text?" first
  // (phone-share.js checkText). Yes here; the "no" paths are in
  // tests/r6-texting-links-2026-10-07.test.js.
  ctx.window.NBDPhoneShare = { checkText: async () => ({ ok: true }) };
  ctx.window._currentLead = opts.lead || { id: 'lead-123', firstName: 'Dana', phone: '5135550123' };
  ctx.window.PortalLinkHelpers = opts.noHelpers ? undefined : {
    resolveUrl: async (id) => { minted.push(id); return 'https://x.test/pro/portal?token=TOK'; },
    recordShare: (id, via) => { recorded.push([id, via]); },
    emailForLead: async () => { recorded.push(['lead-123', 'email-delegated']); },
    previewForLead: async () => {},
  };
  // Only reached when PortalLinkHelpers is absent.
  ctx.CustomerPortal = ctx.window.CustomerPortal = {
    generate: async (id) => { minted.push('generate:' + id); return 'https://x.test/pro/portal?token=FRESH'; },
  };
  ctx.window.getDoc = async () => ({
    exists: () => true,
    data: () => ({ portalUrl: 'https://firebasestorage.googleapis.com/legacy-permanent-link' }),
  });
  ctx.window.doc = () => ({});
  ctx.window.db = {};

  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, recorded, toasts, minted, els };
}

/* ══════════════════════════════════════════════════════════════════
   1. The primary buttons record
   ══════════════════════════════════════════════════════════════════ */
group('Copy Portal Link records the share', async () => {});

(async () => {
  {
    const h = load({});
    await h.ctx.window.quickCopyPortalLink();
    assert('a successful copy records via "copy"',
      JSON.stringify(h.recorded) === JSON.stringify([['lead-123', 'copy']]),
      JSON.stringify(h.recorded));
    assert('...and the rep still gets the confirmation toast',
      h.toasts.some(([, m]) => /copied/i.test(m)));
  }
  {
    // Clipboard API refused AND execCommand refused: the rep is shown the
    // "press Ctrl+C" fallback. Nothing has been handed over yet.
    const h = load({ clipboardFails: true, execCommandWorks: false });
    await h.ctx.window.quickCopyPortalLink();
    assert('a failed copy records NOTHING',
      h.recorded.length === 0,
      'recorded ' + JSON.stringify(h.recorded) + ' — matches PortalLinkHelpers.copyForLead, '
      + 'which also records only on a confirmed copy');
  }
  {
    const h = load({ clipboardFails: true, execCommandWorks: true });
    await h.ctx.window.quickCopyPortalLink();
    assert('the execCommand fallback counts as a real copy',
      JSON.stringify(h.recorded) === JSON.stringify([['lead-123', 'copy']]),
      JSON.stringify(h.recorded));
  }

  group('Text Portal Link records the share', () => {});
  {
    const h = load({});
    await h.ctx.window.quickSmsPortalLink();
    assert('handing the message to the SMS composer records via "sms"',
      JSON.stringify(h.recorded) === JSON.stringify([['lead-123', 'sms']]),
      JSON.stringify(h.recorded));
    assert('...and the composer was actually invoked',
      /^sms:5135550123\?body=/.test(h.ctx.location.href), h.ctx.location.href);
  }
  {
    const h = load({ lead: { id: 'lead-123', firstName: 'Dana', phone: '' } });
    await h.ctx.window.quickSmsPortalLink();
    assert('no phone number → no share recorded', h.recorded.length === 0,
      JSON.stringify(h.recorded));
    assert('...and no token is minted for a text that cannot be sent',
      h.minted.length === 0, JSON.stringify(h.minted));
  }

  group('The share panel copy button records too', () => {});
  {
    const h = load({});
    h.els.fullPortalUrl.value = 'https://x.test/pro/portal?token=ALREADY';
    await h.ctx.copyPortalUrl('fullPortalUrl');
    assert('copying from the panel records via "copy"',
      JSON.stringify(h.recorded) === JSON.stringify([['lead-123', 'copy']]),
      JSON.stringify(h.recorded) + ' — this was the third unrecorded path, and the '
      + 'one the original report did not name');
  }
  {
    const h = load({ clipboardFails: true });
    h.els.fullPortalUrl.value = 'https://x.test/pro/portal?token=ALREADY';
    await h.ctx.copyPortalUrl('fullPortalUrl');
    assert('a failed panel copy records nothing', h.recorded.length === 0,
      JSON.stringify(h.recorded));
  }

  group('Email delegates, and the delegate records', () => {
    // quickEmailPortalLink was ALREADY correct: it hands the whole flow to
    // PortalLinkHelpers.emailForLead, which records. Asserted so a future
    // "consistency" refactor that inlines it here cannot quietly drop the
    // recording the way the copy and SMS handlers did.
    assert('quickEmailPortalLink still delegates wholly to emailForLead',
      /quickEmailPortalLink[\s\S]{0,600}?PortalLinkHelpers\.emailForLead/.test(SRC));
  });

  /* ════════════════════════════════════════════════════════════════
     2. No path can hand out a legacy, unrevocable Storage link
     ════════════════════════════════════════════════════════════════ */
  group('The fallback mints instead of resurrecting a legacy link', () => {});
  {
    const h = load({ noHelpers: true });
    h.els.fullPortalUrl.value = '';
    await h.ctx.window.quickCopyPortalLink();
    assert('with the shared module absent, a fresh token is minted',
      h.minted.some((m) => String(m).startsWith('generate:')), JSON.stringify(h.minted));
    // The lead doc in this stub carries a firebasestorage.googleapis.com
    // portalUrl. Those are the permanent, UNREVOCABLE links the token
    // migration retired — revokePortalToken has never been able to touch one.
    assert('the persisted lead.portalUrl is NOT handed out',
      !h.toasts.some(([, m]) => /firebasestorage/.test(m))
        && h.ctx.window._lastResolved !== 'https://firebasestorage.googleapis.com/legacy-permanent-link');
  }
  // Structural: the read is gone entirely, not merely deprioritised. Strip
  // comments line-wise first — the comment explaining the removal names the
  // very field, and a raw search would match the explanation.
  const stripped = SRC.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  group('The legacy read is gone from the source', () => {
    assert('the stripper did not eat the resolver it guards',
      stripped.indexOf('async function _resolvePortalUrl') > -1
        && stripped.length > SRC.length * 0.5,
      'kept ' + Math.round((stripped.length / SRC.length) * 100) + '%');
    assert('no code path reads data.portalUrl any more',
      stripped.indexOf('data.portalUrl') === -1);
    assert('...and the getDoc lookup it existed for is gone with it',
      stripped.indexOf('getDoc') === -1);
  });

  /* ════════════════════════════════════════════════════════════════
     3. The contract: no share control may skip recording
     ════════════════════════════════════════════════════════════════ */
  group('Every share control in the file is accounted for', () => {
    const controls = [...stripped.matchAll(/window\.(quick\w*PortalLink) = async function/g)]
      .map((m) => m[1]).sort();
    assert('found the expected set of quick* controls',
      JSON.stringify(controls) === JSON.stringify(
        ['quickCopyPortalLink', 'quickEmailPortalLink', 'quickPreviewPortalLink', 'quickSmsPortalLink']),
      JSON.stringify(controls) + ' — a NEW control here must either call '
      + '_recordPortalShare or delegate to a PortalLinkHelpers function that records');

    // Preview is correctly excluded: a rep looking is not a share.
    const previewBody = stripped.slice(stripped.indexOf('window.quickPreviewPortalLink'),
      stripped.indexOf('window.quickEmailPortalLink'));
    assert('preview does NOT record a share (a rep looking is not a share)',
      previewBody.indexOf('_recordPortalShare') === -1);

    assert('the recorder routes through PortalLinkHelpers.recordShare',
      /function _recordPortalShare[\s\S]{0,400}?PortalLinkHelpers\.recordShare\(/.test(SRC));
    assert('a recordShare failure cannot break a share that already succeeded',
      /function _recordPortalShare\(via\) \{\s*try \{/.test(SRC));
  });

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();
