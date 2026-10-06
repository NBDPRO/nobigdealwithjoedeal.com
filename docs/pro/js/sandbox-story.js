// sandbox-story.js — /pro/sandbox, the guided NBD Pro demo (2026-10-06).
//
// One sample job told in nine steps: storm + door-knock map → lead → photo
// report → good/better/best estimate → AI follow-up in the Agent inbox →
// e-sign → crew → invoice → paid. Every screen is rendered here from the
// SAMPLE object below, in the browser. Nothing is fetched, nothing is
// written, nothing is sent: no Firebase, no analytics, no network (tests/
// pro-demo-story-2026-10-06.test.js runs every screen with the network
// trapped and fails on any call).
//
// Real rules, not copies of them:
//   • window.NBDDepositRule (deposit-rule.js) decides what is due when — a
//     Kentucky insurance job gets "nothing at signing" from the rule itself.
//   • window.NBDJurisdiction (ky-insurance-law.js) supplies the statutory
//     notices and decides when the pay link unlocks (payLinkHold).
//   • The inbox reuses the Agent inbox's own markup classes (agent-inbox.css).
//
// CSP-safe: one click delegate on [data-sx-*]; no inline handlers.
// Honesty: sample data is labelled; prices are samples; no lifetime claims;
// no claim-outcome promises; GAF System Plus on Standard and up (Jo 10/05).
(function (root) {
  'use strict';

  // ── Sample data (all invented) ──────────────────────────────────────────
  var SAMPLE = {
    company: 'Sample Roofing Co.',
    bot: 'Follow-up helper',
    customer: 'Jordan Avery',
    first: 'Jordan',
    street: '214 Sample Ridge Rd',
    cityLine: 'Fort Thomas, KY 41075',
    carrier: 'Sample Mutual Insurance',
    zone: 'Fort Thomas north',
    squares: 26,
    pitch: '7/12',
    deductible: 1000,      // dollars (the rule takes dollars, works in cents)
    acv: 12400,            // the carrier scope's actual cash value
    decisionDate: '2026-10-14',
    tz: 'America/New_York',
    // GAF System Plus on Standard and up (Jo, 2026-10-05). Sample prices.
    tiers: [
      { key: 'good', label: 'Standard', shingle: 'GAF Timberline NS', priceCents: 1430000,
        items: ['Full tear-off to the deck', 'Synthetic underlayment', 'GAF starter strip, leak barrier and hip & ridge cap'] },
      { key: 'better', label: 'Preferred', shingle: 'GAF Timberline HDZ', priceCents: 1716000,
        items: ['Everything in Standard', 'Ridge vent sized to the attic', 'Upgraded pipe boots'] },
      { key: 'best', label: 'Elite', shingle: 'GAF Timberline UHDZ', priceCents: 2002000,
        items: ['Everything in Preferred', 'Thicker, heavier shingle', 'Leak barrier in every valley and at every wall'] }
    ],
    systemPlus: 'GAF System Plus Limited Warranty included'
  };

  // D2D outcomes: labels + colours are the real ones (d2d-tracker-core-2026b.js DISPOSITIONS).
  var OUTCOMES = {
    appointment: { label: 'Appointment Set', color: '#2ECC8A' },
    storm_damage: { label: 'Storm Damage Noted', color: '#BD5728' },
    interested: { label: 'Interested', color: '#EAB308' },
    not_home: { label: 'Not Home', color: '#6B7280' },
    do_not_knock: { label: 'Do Not Knock', color: '#1F2937' }
  };
  var DOORS = [
    [62, 60, 'not_home'], [96, 52, 'storm_damage'], [130, 44, 'not_home'], [212, 58, 'interested'],
    [246, 66, 'not_home'], [78, 104, 'do_not_knock'], [118, 112, 'not_home'], [208, 108, 'storm_damage'],
    [244, 116, 'not_home'], [100, 152, 'interested'], [140, 158, 'not_home'], [226, 156, 'not_home']
  ];
  var CUSTOMERS = [[36, 84], [152, 74], [270, 96], [186, 150], [60, 160], [282, 140], [160, 30]];
  var TARGET = [172, 96];

  var STEP_IDS = ['storm', 'lead', 'report', 'estimate', 'follow-up', 'sign', 'crew', 'invoice', 'paid'];
  var STEP_NAMES = ['Storm', 'Lead', 'Report', 'Estimate', 'AI follow-up', 'Sign', 'Crew', 'Invoice', 'Paid'];
  var DRAFT = 'Hi Jordan, it’s Sam with Sample Roofing. Any questions on the three roof options I sent Wednesday? Happy to walk through them by phone, or stop by. No rush.';

  function freshState() {
    return { door: false, tag: false, report: 'roof', tier: 'better', inbox: 'pending', reminder: 'pending',
      draft: DRAFT, mode: 'ky', signed: false, sheet: false, rain: 0, inv: 'held', paid: false };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(cents) {
    var n = Math.round(Number(cents) || 0);
    var d = Math.floor(n / 100), c = n % 100;
    return '$' + String(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (c ? '.' + (c < 10 ? '0' : '') + c : '');
  }
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function day(iso) {
    var d = new Date(iso + 'T12:00:00Z');
    return DOW[d.getUTCDay()] + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  // Rain day: push the start, skipping weekends (what the production strip does).
  function addWorkdays(iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    var left = n;
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      var w = d.getUTCDay();
      if (w !== 0 && w !== 6) left--;
    }
    return d.toISOString().slice(0, 10);
  }
  function tierOf(st) {
    for (var i = 0; i < SAMPLE.tiers.length; i++) if (SAMPLE.tiers[i].key === st.tier) return SAMPLE.tiers[i];
    return SAMPLE.tiers[1];
  }
  function address() { return SAMPLE.street + ', ' + SAMPLE.cityLine; }
  function lead(st, decided) {
    return { address: address(), jobType: st.mode === 'ky' ? 'insurance' : 'retail',
      insuranceCarrier: st.mode === 'ky' ? SAMPLE.carrier : '', carrierDecisionAt: decided ? SAMPLE.decisionDate : null };
  }

  // What is due when: the real deposit rule, for the real address.
  function payPlan(st) {
    var R = root && root.NBDDepositRule;
    if (!R || typeof R.compute !== 'function') return null;
    var total = tierOf(st).priceCents / 100;
    if (st.mode === 'ky') {
      return R.compute({ total: total, mode: 'insurance', deductible: SAMPLE.deductible, acv: SAMPLE.acv, address: address() });
    }
    return R.compute({ total: total, mode: 'cash', address: address() });
  }

  // Is the pay link held? The real Kentucky test (payLinkHold), on the
  // sample dates: the day after the decision, then the day it unlocks.
  function payHold(st) {
    var J = root && root.NBDJurisdiction;
    if (!J || typeof J.payLinkHold !== 'function') return { held: st.mode === 'ky', releaseDate: '' };
    if (st.mode !== 'ky') return J.payLinkHold(lead(st, false), {}, '2026-10-29', SAMPLE.tz);
    if (st.inv === 'held') return J.payLinkHold(lead(st, false), {}, '2026-10-16', SAMPLE.tz);
    if (st.inv === 'decision') return J.payLinkHold(lead(st, true), {}, '2026-10-16', SAMPLE.tz);
    return J.payLinkHold(lead(st, true), {}, '2026-10-22', SAMPLE.tz);
  }

  function app(name, body) {
    return '<div class="sx-app" role="group" aria-label="' + esc(name) + ' in the NBD Pro app, sample data">' +
      '<div class="sx-app-bar"><span class="sx-app-name">' + esc(name) + '</span><span class="sx-tag">Sample</span></div>' +
      '<div class="sx-app-body">' + body + '</div></div>';
  }
  function doc(label, body) {
    return '<div class="sx-doc nbd-brand" role="group" aria-label="' + esc(label) + ', sample data">' +
      '<div class="sx-doc-bar"><span>' + esc(label) + '</span><span class="nbd-pill nbd-pill-neutral">Sample</span></div>' +
      '<div class="sx-doc-body">' + body + '</div></div>';
  }
  function btn(act, val, label, cls, extra) {
    return '<button type="button" class="sx-btn' + (cls ? ' ' + cls : '') + '" data-sx-act="' + act + '"' +
      (val != null ? ' data-sx-val="' + esc(val) + '"' : '') + (extra || '') + '>' + label + '</button>';
  }
  function seg(act, current, options, aria) {
    return '<div class="sx-seg" role="group" aria-label="' + esc(aria) + '">' + options.map(function (o) {
      return '<button type="button" class="sx-seg-btn" data-sx-act="' + act + '" data-sx-val="' + o[0] + '" aria-pressed="' +
        (current === o[0]) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  // A Kentucky insurance job takes no deposit, so its 4th stage is the deductible.
  function chain(doneThrough, st) {
    var stages = ['Meeting booked', 'Estimate shared', 'Contract signed', (st && st.mode === 'retail') ? 'Deposit paid' : 'Deductible paid', 'Paid in full'];
    return '<ol class="sx-chain" aria-label="Pipeline stages">' + stages.map(function (s, i) {
      var cls = i < doneThrough ? 'is-done' : (i === doneThrough ? 'is-now' : '');
      return '<li class="' + cls + '"' + (i === doneThrough ? ' aria-current="step"' : '') + '>' + esc(s) + '</li>';
    }).join('') + '</ol>';
  }
  function rows(plan, paidKeys) {
    if (!plan || !plan.rows) return '';
    return '<table class="sx-rows"><caption>When each payment is due</caption><tbody>' + plan.rows.map(function (r) {
      var paid = paidKeys && paidKeys.indexOf(r.key) !== -1;
      return '<tr' + (paid ? ' class="is-paid"' : '') + '><th scope="row">' + esc(r.label) + '<span class="sx-due">' + esc(r.due) + '</span></th>' +
        '<td>' + esc(r.amountText) + (paid ? '<span class="sx-paid-mark">Paid</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  function notice(summary, full) {
    return '<details class="sx-notice"><summary>' + esc(summary) + '</summary><p>' + esc(full) + '</p></details>';
  }

  // ── Screens ─────────────────────────────────────────────────────────────
  var SCREENS = {};

  SCREENS.storm = function (st) {
    var svg = '<svg class="sx-map" viewBox="0 0 320 200" role="img" aria-label="Door-knocking map: a hail swath over the neighborhood, 12 knocked doors, 7 of your customers, and one door marked Appointment Set">' +
      '<rect class="sx-map-bg" x="0" y="0" width="320" height="200" rx="10"/>' +
      '<path class="sx-road" d="M0 82H320M0 134H320M48 0V200M168 0V200M262 0V200"/>' +
      '<polygon class="sx-swath" points="20,30 300,50 304,150 14,128"/>' +
      CUSTOMERS.map(function (c) { return '<rect class="sx-cust" x="' + (c[0] - 5) + '" y="' + (c[1] - 5) + '" width="10" height="10" rx="2"/>'; }).join('') +
      DOORS.map(function (d) { return '<circle class="sx-door" cx="' + d[0] + '" cy="' + d[1] + '" r="5" fill="' + OUTCOMES[d[2]].color + '"/>'; }).join('') +
      '<circle class="sx-target-ring' + (st.door ? ' is-on' : '') + '" cx="' + TARGET[0] + '" cy="' + TARGET[1] + '" r="12"/>' +
      '<circle class="sx-door" cx="' + TARGET[0] + '" cy="' + TARGET[1] + '" r="7" fill="' + OUTCOMES.appointment.color + '"/>' +
      '<circle class="sx-hit" data-sx-act="door" cx="' + TARGET[0] + '" cy="' + TARGET[1] + '" r="22" aria-hidden="true"/>' +
      '</svg>';
    var legend = '<ul class="sx-legend">' + Object.keys(OUTCOMES).map(function (k) {
      return '<li><span class="sx-dot" data-sx-o="' + k + '"></span>' + esc(OUTCOMES[k].label) + '</li>';
    }).join('') + '<li><span class="sx-dot sx-dot-cust"></span>Your customer</li></ul>';
    var sheet = st.door
      ? '<div class="sx-sheet" role="status"><p class="sx-sheet-top"><span class="sx-dot" data-sx-o="appointment"></span>Appointment Set</p>' +
        '<dl class="sx-kv"><dt>Door</dt><dd>' + esc(SAMPLE.street) + '</dd><dt>Owner</dt><dd>' + esc(SAMPLE.customer) + '</dd>' +
        '<dt>When</dt><dd>' + day('2026-10-06') + ', 10:00 AM</dd><dt>Note</dt><dd>Dents on the gutters and vents. Wants the roof checked.</dd></dl>' +
        '<button type="button" class="sx-btn sx-btn-primary" data-sx-nav="next">See the lead</button></div>'
      : btn('door', null, 'Open the green door: ' + esc(SAMPLE.street), 'sx-btn-primary');
    return app('Storm Center + door knocking',
      '<div class="sx-alert"><p class="sx-alert-h">Severe Thunderstorm Warning</p>' +
      '<p>National Weather Service · hail up to 1.25 in. · ' + day('2026-10-03') + '</p>' +
      '<p class="sx-alert-zone">Storm zone <b>' + esc(SAMPLE.zone) + '</b>: <b>7 of your customers</b> are inside it.</p></div>' +
      svg + legend +
      '<ul class="sx-stats"><li><b>12</b> doors knocked</li><li><b>4</b> talked</li><li><b>1</b> appointment</li></ul>' + sheet);
  };

  SCREENS.lead = function (st) {
    return app('Pipeline · Insurance',
      chain(0, st) +
      '<article class="sx-card"><p class="sx-card-name">' + esc(SAMPLE.customer) + '</p>' +
      '<p class="sx-card-sub">' + esc(address()) + '</p>' +
      '<p class="sx-pills"><span class="sx-pill">Insurance</span><span class="sx-pill">Kentucky</span><span class="sx-pill">Door knock</span></p>' +
      '<dl class="sx-kv"><dt>Next</dt><dd>Inspection ' + day('2026-10-06') + ', 10:00 AM</dd>' +
      '<dt>Source</dt><dd>Door knock in storm zone ' + esc(SAMPLE.zone) + '</dd>' +
      '<dt>Logged</dt><dd>Appointment Set at the door, by you</dd></dl></article>' +
      '<h3 class="sx-sub-h">Today</h3><ul class="sx-today">' +
      '<li class="is-hl"><b>10:00 AM</b> Inspection · ' + esc(SAMPLE.customer) + '</li>' +
      '<li><b>Call back</b> · a homeowner who asked for one (sample)</li>' +
      '<li><b>Follow up</b> · an estimate opened twice (sample)</li></ul>');
  };

  var PHOTOS = [
    { src: '/assets/images/projects/hail-impact-chalk-marked-1.webp', tag: 'Hail hit', where: 'North slope', alt: 'Sample photo: hail impacts circled in chalk on shingles' },
    { src: '/assets/images/projects/hail-impact-chalk-marked-2.webp', tag: 'Hail hit', where: 'West slope', alt: 'Sample photo: more chalk-circled hail impacts on a second slope' },
    { src: '/assets/images/roofing-2-800.webp', tag: 'Overview', where: 'From above', alt: 'Sample photo: the house and roof from above' }
  ];
  function photoImg(p) {
    return '<img src="' + p.src + '" width="800" height="600" alt="' + esc(p.alt) + '" loading="lazy" decoding="async">';
  }

  SCREENS.report = function (st) {
    var tabs = seg('report', st.report, [['roof', 'On the roof'], ['home', 'Homeowner report']], 'Report view');
    if (st.report === 'roof') {
      var tiles = PHOTOS.map(function (p, i) {
        var tag = (i === 1 && !st.tag)
          ? btn('tag', null, 'AI suggests: Hail hit · Accept', 'sx-btn-chip')
          : '<span class="sx-tagchip">' + esc(p.tag) + '</span>';
        return '<figure class="sx-photo">' + photoImg(p) + '<figcaption>' + tag + '<span>' + esc(p.where) + ' · on-site</span></figcaption></figure>';
      }).join('');
      return tabs + app('Photos · ' + SAMPLE.customer,
        '<div class="sx-photos">' + tiles + '</div>' +
        btn('report', 'home', 'Build the Storm Damage report', 'sx-btn-primary'));
    }
    var grid = PHOTOS.map(function (p) {
      return '<figure class="nbd-photo-tile">' + photoImg(p) + '<figcaption class="nbd-photo-tile-caption">' + esc(p.tag + ' · ' + p.where) + '</figcaption></figure>';
    }).join('');
    return tabs + doc('What the homeowner gets',
      '<p class="nbd-eyebrow">' + esc(SAMPLE.company) + '</p><h3 class="sx-doc-h">Storm Damage Report</h3>' +
      '<div class="nbd-kv"><span class="nbd-kv-key">Property</span><span class="nbd-kv-val">' + esc(address()) + '</span>' +
      '<span class="nbd-kv-key">Inspected</span><span class="nbd-kv-val">' + day('2026-10-06') + '</span></div>' +
      '<h4 class="sx-doc-h4">What we found</h4><p>Hail impacts on the north and west slopes, marked in chalk, and dents on the gutters and vents.</p>' +
      '<div class="nbd-photo-grid sx-report-grid">' + grid + '</div>' +
      '<h4 class="sx-doc-h4">What happens next</h4><p>Whether to open a claim is your decision, and your insurance company decides what is covered. If you file, we can meet your adjuster on the roof and show what we documented.</p>' +
      '<p class="sx-small">Shared with one secure link: no login, no app.</p>');
  };

  SCREENS.estimate = function (st) {
    var cards = SAMPLE.tiers.map(function (t) {
      var on = t.key === st.tier;
      return '<button type="button" class="sx-tier" data-sx-act="tier" data-sx-val="' + t.key + '" aria-pressed="' + on + '">' +
        '<span class="sx-tier-name">' + esc(t.label) + '</span><span class="sx-tier-shingle">' + esc(t.shingle) + '</span>' +
        '<span class="sx-tier-price">' + money(t.priceCents) + '<small>sample price</small></span>' +
        '<span class="sx-tier-list">' + t.items.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') +
        '<span class="sx-tier-sp">' + esc(SAMPLE.systemPlus) + '</span></span>' +
        (on ? '<span class="sx-tier-picked">Picked</span>' : '') + '</button>';
    }).join('');
    var t = tierOf(st);
    return doc('What the homeowner sees',
      '<p class="nbd-eyebrow">' + esc(SAMPLE.company) + ' · ' + esc(SAMPLE.street) + '</p>' +
      '<h3 class="sx-doc-h">Your roof options</h3>' +
      '<p class="sx-small">Measured: ' + SAMPLE.squares + ' squares, ' + SAMPLE.pitch + ' pitch. Prices are samples; you set your own.</p>' +
      '<div class="sx-tiers">' + cards + '</div>' +
      '<p class="sx-pick" role="status">Picked: <b>' + esc(t.label) + '</b>, ' + money(t.priceCents) + ' (sample).</p>' +
      '<p class="sx-small">GAF System Plus is registered with GAF by a GAF Certified contractor, on GAF’s terms.</p>');
  };

  SCREENS['follow-up'] = function (st) {
    var text;
    if (st.inbox === 'pending') {
      text = '<div class="ai-item"><div class="ai-top"><span class="ai-kind">💬 Text draft</span><span class="ai-cust">' + esc(SAMPLE.customer) + '</span></div>' +
        '<div class="ai-meta">drafted by ' + esc(SAMPLE.bot) + ' · <span class="ai-ok">texting consent on file</span></div>' +
        '<div class="ai-qnote">Why: the estimate was opened twice since Wednesday, and no reply yet.</div>' +
        '<textarea class="ai-text" id="sx-draft" data-sx-draft rows="4" maxlength="320" aria-label="Text draft to ' + esc(SAMPLE.customer) + '">' + esc(st.draft) + '</textarea>' +
        '<div class="ai-actions"><button type="button" class="ai-btn" data-sx-act="inbox" data-sx-val="tossed">Toss</button>' +
        '<button type="button" class="ai-btn is-primary" data-sx-act="inbox" data-sx-val="sent">Text from my phone</button></div></div>';
    } else if (st.inbox === 'sent') {
      text = '<div class="ai-item sx-done" role="status"><div class="ai-top"><span class="ai-kind">Sent by you</span><span class="ai-cust">' + esc(SAMPLE.customer) + '</span></div>' +
        '<p class="ai-note">On your phone, Messages opens with this text filled in and you press send. NBD Pro logs it on ' + esc(SAMPLE.first) + '’s card. (In this demo nothing was sent.)</p>' +
        '<p class="sx-quote">' + esc(st.draft) + '</p>' +
        '<div class="ai-actions"><button type="button" class="ai-btn" data-sx-act="inbox" data-sx-val="pending">Undo (demo)</button></div></div>';
    } else {
      text = '<div class="ai-item sx-done" role="status"><p class="ai-note">Tossed. Nothing was sent, and the bot never sends on its own.</p>' +
        '<div class="ai-actions"><button type="button" class="ai-btn" data-sx-act="inbox" data-sx-val="pending">Bring it back (demo)</button></div></div>';
    }
    var rem = st.reminder === 'pending'
      ? '<div class="ai-item"><div class="ai-top"><span class="ai-kind">⏰ Reminder</span><span class="ai-cust">' + esc(SAMPLE.customer) + '</span><span class="ai-due">due Thu</span></div>' +
        '<div class="ai-meta">from ' + esc(SAMPLE.bot) + '</div><div class="ai-title">Call ' + esc(SAMPLE.first) + ' Thursday if there is no reply.</div>' +
        '<div class="ai-actions"><button type="button" class="ai-btn" data-sx-act="reminder" data-sx-val="tossed">Toss</button>' +
        '<button type="button" class="ai-btn is-primary" data-sx-act="reminder" data-sx-val="added">Add to CRM</button></div></div>'
      : '<div class="ai-item sx-done" role="status"><p class="ai-note">' + (st.reminder === 'added' ? 'Reminder added to ' + esc(SAMPLE.first) + '’s card (demo).' : 'Reminder tossed (demo).') + '</p></div>';
    return app('Agent inbox',
      '<p class="ai-note">Your bots filed 2 items. Nothing here reaches a customer until you tap.</p>' + text + rem);
  };

  SCREENS.sign = function (st) {
    var J = root && root.NBDJurisdiction;
    var t = tierOf(st);
    var plan = payPlan(st);
    var toggle = seg('mode', st.mode, [['ky', 'Kentucky insurance job'], ['retail', 'Retail (cash) job']], 'Job type');
    var money1;
    var notices;
    if (st.mode === 'ky') {
      money1 = '<div class="sx-callout is-ok"><p class="sx-callout-h">Nothing is due at signing.</p>' +
        '<p>' + esc(plan ? plan.summary.replace(/^Nothing is due at signing\.\s*/, '') : '') + '</p></div>' + rows(plan) +
        '<p class="sx-lock"><span aria-hidden="true">🔒</span> Online pay link locked until the insurer’s written decision plus 5 business days.</p>';
      notices = (J ? notice('You may cancel within 5 business days after your insurer’s written decision that part of the work is not covered.', J.KY_NOTICE_CANCEL) +
        notice('No assignment of benefits: this contract does not transfer your insurance rights. The claim stays yours.', J.KY_NOTICE_NO_ASSIGNMENT) +
        notice('3-day right to cancel, with two Notice of Cancellation forms attached.', J.FTC_STATEMENT) : '');
    } else {
      money1 = '<div class="sx-callout"><p class="sx-callout-h">' + esc(plan ? plan.label + ': ' + plan.valueText : '') + '</p>' +
        '<p>' + esc(plan ? plan.summary : '') + '</p></div>' + rows(plan) +
        '<p class="sx-small">The deposit pay link goes out right after signing.</p>';
      notices = J ? notice('3-day right to cancel, with two Notice of Cancellation forms attached.', J.FTC_STATEMENT) : '';
    }
    var sig = st.signed
      ? '<div class="sx-sigpad is-signed" role="img" aria-label="Signed by ' + esc(SAMPLE.customer) + '"><svg viewBox="0 0 220 60" aria-hidden="true"><path class="sx-sig-path" d="M8 42c14-26 22-30 26-18s-6 20 4 14 14-28 22-20-4 22 8 16 16-16 24-10 2 14 14 8 18-12 26-8 10 6 22 2 22-6 30-4"/></svg></div>' +
        '<p class="sx-small">Signed by ' + esc(SAMPLE.customer) + ' on their phone. Consent, IP, browser and time recorded; an audit certificate is added to the signed PDF.</p>'
      : '<button type="button" class="sx-sigpad" data-sx-act="sign">Tap to sign as ' + esc(SAMPLE.customer) + '</button>';
    return toggle + doc('What the homeowner signs',
      '<p class="nbd-eyebrow">' + esc(SAMPLE.company) + '</p><h3 class="sx-doc-h">Roofing Agreement</h3>' +
      '<div class="nbd-kv"><span class="nbd-kv-key">Homeowner</span><span class="nbd-kv-val">' + esc(SAMPLE.customer) + '</span>' +
      '<span class="nbd-kv-key">Property</span><span class="nbd-kv-val">' + esc(address()) + '</span>' +
      '<span class="nbd-kv-key">Package</span><span class="nbd-kv-val">' + esc(t.label + ', ' + t.shingle) + '</span>' +
      '<span class="nbd-kv-key">Price</span><span class="nbd-kv-val">' + money(t.priceCents) + ' (sample)</span></div>' +
      money1 + '<div class="sx-notices">' + notices + '</div>' + sig);
  };

  SCREENS.crew = function (st) {
    var start = addWorkdays('2026-10-28', st.rain);
    var delivery = addWorkdays('2026-10-27', st.rain);
    var t = tierOf(st);
    var strip = [['Permit', 'Filed ' + day('2026-10-13'), true], ['Ordered', t.shingle + ', 26 sq + accessories', true],
      ['Delivery', day(delivery), false], ['Sub', 'Sample Crew A · insurance certificate on file', false], ['Start', day(start), false]];
    var sheet = st.sheet
      ? '<div class="sx-sheet" role="status"><p class="sx-sheet-top">Job sheet sent to Sample Crew A</p><dl class="sx-kv">' +
        '<dt>Address</dt><dd>' + esc(address()) + '</dd><dt>Start</dt><dd>' + day(start) + ', 7:00 AM</dd>' +
        '<dt>Materials</dt><dd>' + esc(t.shingle) + ', 26 squares, starter, leak barrier, hip &amp; ridge</dd>' +
        '<dt>Not on it</dt><dd>Your prices and the homeowner’s phone</dd></dl></div>'
      : '';
    return app('Production',
      '<p class="sx-card-name">' + esc(SAMPLE.customer) + ' · ' + esc(t.label) + '</p>' +
      '<ol class="sx-strip">' + strip.map(function (s) {
        return '<li class="' + (s[2] ? 'is-done' : '') + '"><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></li>';
      }).join('') + '</ol>' +
      (st.rain ? '<p class="sx-small" role="status">Pushed ' + st.rain + ' rain day' + (st.rain > 1 ? 's' : '') + '. Every later job moved too, skipping weekends.</p>' : '') +
      '<div class="sx-row">' + btn('sheet', null, st.sheet ? 'Hide job sheet' : 'Send to sub', 'sx-btn-primary') +
      btn('rain', null, 'Rain day', '', st.rain >= 3 ? ' disabled' : '') + '</div>' + sheet +
      '<p class="sx-small">' + esc(SAMPLE.first) + '’s portal now shows: Build day set, ' + day(start) + '.</p>');
  };

  SCREENS.invoice = function (st) {
    var t = tierOf(st);
    var plan = payPlan(st);
    var hold = payHold(st);
    var paidKeys = [];
    var action = '';
    var status = '';
    if (st.mode === 'ky') {
      if (st.inv === 'acvpaid') paidKeys = ['deductible', 'acv'];
      if (st.inv === 'held') {
        status = '<p class="sx-lock"><span aria-hidden="true">🔒</span> Pay link locked: waiting on the insurer’s written decision.</p>';
        action = btn('inv', 'decision', 'Record the carrier’s decision (' + day(SAMPLE.decisionDate) + ')', 'sx-btn-primary');
      } else if (st.inv === 'decision') {
        status = '<p class="sx-lock"><span aria-hidden="true">🔒</span> Decision received ' + day(SAMPLE.decisionDate) + '. Pay link unlocks ' + esc(hold.releaseDate) + '.</p>';
        action = btn('inv', 'released', 'Skip ahead to ' + esc(hold.releaseDate), 'sx-btn-primary');
      } else if (st.inv === 'released') {
        status = '<p class="sx-open" role="status">Window over. The pay link can go out now.</p>';
        action = btn('inv', 'acvpaid', 'Send the pay link', 'sx-btn-primary');
      } else {
        status = '<p class="sx-open" role="status">' + esc(SAMPLE.first) + ' paid the deductible and the ACV payment by card (sample).</p>';
      }
    } else {
      paidKeys = ['deposit'];
      status = st.inv === 'acvpaid'
        ? '<p class="sx-open" role="status">Balance link sent after the build (sample).</p>'
        : '<p class="sx-open">Deposit paid at signing. The balance is due on completion.</p>';
      action = st.inv === 'acvpaid' ? '' : btn('inv', 'acvpaid', 'Send the balance link', 'sx-btn-primary');
    }
    var pay = hold.held
      ? '<button type="button" class="nbd-btn nbd-btn-ghost sx-paybtn" disabled>Pay online: locked</button>'
      : '<span class="nbd-btn nbd-btn-primary sx-paybtn" aria-disabled="true">Pay online (card)</span>';
    return doc('The invoice the homeowner gets',
      '<p class="nbd-eyebrow">' + esc(SAMPLE.company) + ' · Invoice 1042 (sample)</p>' +
      '<table class="sx-rows sx-lines"><tbody><tr><th scope="row">Roof replacement, ' + esc(t.label) + ' package<span class="sx-due">' + esc(t.shingle) + '</span></th><td>' + money(t.priceCents) + '</td></tr></tbody></table>' +
      rows(plan, paidKeys) + status + pay +
      '<p class="sx-small">Or pay by check, cash or Zelle; the instructions print on the invoice.</p>') +
      '<div class="sx-rep-actions">' + action + '</div>';
  };

  SCREENS.paid = function (st) {
    var plan = payPlan(st);
    var last = plan && plan.rows && plan.rows.length ? plan.rows[plan.rows.length - 1] : null;
    var body = st.paid
      ? '<div class="sx-stamp" role="status"><p class="sx-stamp-h">Paid in full</p><p>Balance ' + money(0) + '. ' + esc(SAMPLE.first) + '’s portal now asks for a review and a referral.</p></div>' + chain(5, st)
      : '<dl class="sx-kv"><dt>Amount</dt><dd>' + esc(last ? last.amountText : '') + ' (the balance)</dd><dt>Method</dt><dd>Check #2231 (sample)</dd>' +
        '<dt>Proof</dt><dd>Photo of the check attached</dd></dl>' + btn('record', null, 'Record payment', 'sx-btn-primary') + chain(4, st);
    return app('Record a payment · ' + SAMPLE.customer, body);
  };

  function renderScreen(id, st) {
    var fn = SCREENS[id];
    return fn ? fn(st || freshState()) : '';
  }

  var API = { SAMPLE: SAMPLE, OUTCOMES: OUTCOMES, STEP_IDS: STEP_IDS, freshState: freshState,
    renderScreen: renderScreen, payPlan: payPlan, payHold: payHold, money: money };
  if (root) root.NBDProDemo = API;
  if (typeof module === 'object' && module.exports) module.exports = API;

  // ── Page wiring (only on /pro/sandbox) ──────────────────────────────────
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('sx-stage')) return;

  var state = freshState();
  var steps = Array.prototype.slice.call(document.querySelectorAll('[data-sx-step]'));
  var LAST = steps.length - 1;          // the end screen
  var cur = 0;
  var still = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fill = document.getElementById('sx-bar-fill');
  var count = document.getElementById('sx-count');
  var back = document.querySelector('[data-sx-nav="back"]');
  var next = document.querySelector('[data-sx-nav="next"]');
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-sx-go]'));

  document.documentElement.classList.add('sx-js');

  function paintModeCopy(step) {
    Array.prototype.forEach.call(step.querySelectorAll('[data-sx-mode]'), function (el) {
      el.hidden = el.getAttribute('data-sx-mode') !== state.mode;
    });
  }

  function paint(focusAct) {
    var step = steps[cur];
    var screen = step.querySelector('[data-sx-screen]');
    if (screen) screen.innerHTML = renderScreen(screen.getAttribute('data-sx-screen'), state);
    paintModeCopy(step);
    if (focusAct) {
      var again = step.querySelector('[data-sx-act="' + focusAct + '"]') || step.querySelector('[role="status"]');
      if (again && again.focus) {
        if (!again.hasAttribute('tabindex') && !/^(BUTTON|A|TEXTAREA|INPUT)$/.test(again.tagName)) again.setAttribute('tabindex', '-1');
        again.focus({ preventScroll: true });
      }
    }
  }

  function show(i, opts) {
    cur = Math.max(0, Math.min(LAST, i));
    steps.forEach(function (s, k) {
      s.hidden = k !== cur;
      s.classList.toggle('is-active', k === cur);
    });
    paint();
    var onEnd = cur === LAST;
    fill.style.transform = 'scaleX(' + (onEnd ? 1 : (cur + 1) / LAST) + ')';
    count.textContent = onEnd ? 'Done: all 9 steps' : 'Step ' + (cur + 1) + ' of ' + LAST + ' · ' + STEP_NAMES[cur];
    chips.forEach(function (c, k) {
      if (k === cur) c.setAttribute('aria-current', 'step'); else c.removeAttribute('aria-current');
      c.classList.toggle('is-done', k < cur);
    });
    back.disabled = cur === 0;
    next.textContent = cur === LAST - 1 ? 'Finish' : 'Next';
    document.body.classList.toggle('sx-at-end', onEnd);
    var active = chips[cur];
    if (active && active.parentNode && active.parentNode.parentNode) {
      var row = active.parentNode.parentNode;
      row.scrollLeft = Math.max(0, active.parentNode.offsetLeft - 16);
    }
    try { root.history.replaceState(null, '', '#' + steps[cur].id); } catch (_) { /* file:// or sandboxed frame */ }
    if (opts && opts.initial) return;
    var h = steps[cur].querySelector('h2');
    var top = document.getElementById('sx-progress');
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    if (h) h.focus({ preventScroll: true });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-sx-go],[data-sx-nav],[data-sx-act]') : null;
    if (!t) return;
    if (t.hasAttribute('data-sx-go')) { show(Number(t.getAttribute('data-sx-go'))); return; }
    var nav = t.getAttribute('data-sx-nav');
    if (nav === 'next') { show(cur + 1); return; }
    if (nav === 'back') { show(cur - 1); return; }
    if (nav === 'restart') { state = freshState(); show(0); return; }
    var act = t.getAttribute('data-sx-act');
    var val = t.getAttribute('data-sx-val');
    if (act === 'door') state.door = true;
    else if (act === 'tag') state.tag = true;
    else if (act === 'report') state.report = val === 'home' ? 'home' : 'roof';
    else if (act === 'tier') state.tier = val;
    else if (act === 'inbox') state.inbox = val;
    else if (act === 'reminder') state.reminder = val;
    else if (act === 'mode') { if (state.mode !== val) { state.mode = val === 'retail' ? 'retail' : 'ky'; state.inv = 'held'; state.paid = false; } }
    else if (act === 'sign') state.signed = true;
    else if (act === 'sheet') state.sheet = !state.sheet;
    else if (act === 'rain') state.rain = Math.min(3, state.rain + 1);
    else if (act === 'inv') state.inv = val;
    else if (act === 'record') state.paid = true;
    else return;
    paint(act);
  });

  // Keep an edited draft across repaints.
  document.addEventListener('input', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-sx-draft')) state.draft = e.target.value;
  });

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); show(cur + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(cur - 1); }
  });

  var start = 0;
  var hash = (root.location && root.location.hash || '').replace('#', '');
  steps.forEach(function (s, k) { if (s.id === hash) start = k; });
  show(start, { initial: true });
})(typeof window !== 'undefined' ? window : null);
