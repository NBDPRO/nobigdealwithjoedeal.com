/**
 * NBD Pro — Rep OS v1
 * AI-powered daily briefing & coaching engine
 * Morning auto-brief: follow-ups, coaching, hot neighborhoods, route
 * Ties together D2D, Sales Training, Gamification, and Joe AI
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS
  // ============================================================================

  const BRIEFING_STORAGE_KEY = 'nbd_rep_briefings';
  // The OpenWeatherMap weather card was removed 2026-10-04 (vendor audit
  // Lane D): nothing ever set its localStorage key and api.openweathermap.org
  // was never in connect-src, so the card could not have rendered.

  // Coaching tip categories
  const COACHING_CATEGORIES = {
    opener: { icon: '🎯', label: 'Opening' },
    closing: { icon: '🤝', label: 'Closing' },
    objection: { icon: '🛡️', label: 'Objections' },
    followup: { icon: '📞', label: 'Follow-up' },
    mindset: { icon: '🧠', label: 'Mindset' },
    technique: { icon: '⚡', label: 'Technique' }
  };

  // Smart coaching tips based on performance patterns
  const COACHING_TIPS = {
    low_knock_volume: [
      { cat: 'mindset', text: 'You knocked fewer doors than usual yesterday. Remember: every door is a chance. Set a timer for 2 hours of uninterrupted knocking today.' },
      { cat: 'technique', text: 'Try the "3-street blitz" — pick 3 streets and commit to hitting every single door. Volume beats perfection.' }
    ],
    low_contact_rate: [
      { cat: 'technique', text: 'Your contact rate is below average. Try knocking between 4-7pm when more people are home.' },
      { cat: 'opener', text: 'Slow down your approach. Walk up with confidence, step back from the door, and smile before they open.' }
    ],
    low_close_rate: [
      { cat: 'closing', text: 'You\'re getting contacts but not setting appointments. Try the assumptive close: "I have Tuesday at 2 or Thursday at 4 — which works better?"' },
      { cat: 'objection', text: 'When they say "let me think about it," respond with: "Totally understand. What specifically are you unsure about? I want to make sure you have all the info."' }
    ],
    great_performance: [
      { cat: 'mindset', text: 'You\'re crushing it! Momentum is everything in D2D. Ride this wave and push for a personal best today.' },
      { cat: 'technique', text: 'Your numbers are strong. Challenge yourself: can you help a newer rep learn your approach today?' }
    ],
    follow_up_heavy: [
      { cat: 'followup', text: 'You have several follow-ups due. Start your day with follow-ups before knocking — warm contacts close at 3x the rate of cold doors.' },
      { cat: 'technique', text: 'For follow-ups, lead with value: "Hey, I found something about your roof I wanted to share with you."' }
    ],
    storm_opportunity: [
      { cat: 'opener', text: 'Storm damage in your area! Lead with urgency: "We\'ve been inspecting roofs in the neighborhood and finding damage homeowners can\'t see from the ground."' },
      { cat: 'closing', text: 'After a storm, lead with proof: "I\'ll photo-document everything I find so you can decide whether to file with your insurance company. It\'s your claim — I\'ll give you a clear written estimate for the work either way."' }
    ]
  };

  // ============================================================================
  // STATE
  // ============================================================================

  let briefings = [];
  let todayBriefing = null;
  let isGenerating = false;

  // ============================================================================
  // HELPERS
  // ============================================================================

  function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtDate(d) { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
  function fmtTime(d) { if (!d) return '—'; return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  function todayKey() { return new Date().toISOString().split('T')[0]; }

  // ============================================================================
  // STORAGE
  // ============================================================================

  function loadBriefings() {
    try {
      const raw = localStorage.getItem(BRIEFING_STORAGE_KEY);
      briefings = raw ? JSON.parse(raw) : [];
    } catch (e) { briefings = []; }
    todayBriefing = briefings.find(b => b.date === todayKey());
  }

  function saveBriefings() {
    // Keep last 30 days
    briefings = briefings.filter(b => {
      const diff = Date.now() - new Date(b.date).getTime();
      return diff < 30 * 24 * 60 * 60 * 1000;
    });
    try { localStorage.setItem(BRIEFING_STORAGE_KEY, JSON.stringify(briefings)); }
    catch (e) { console.error('Briefing save error:', e); }
  }

  // ============================================================================
  // DATA COLLECTORS
  // ============================================================================

  function getD2DMetrics() {
    if (!window.D2D) return null;
    try {
      // Pull from D2D tracker's data
      const knocks = window.D2D.getKnocks ? window.D2D.getKnocks() : [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
      const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);

      const todayKnocks = knocks.filter(k => new Date(k.createdAt?.seconds ? k.createdAt.seconds * 1000 : k.createdAt) >= today);
      const yesterdayKnocks = knocks.filter(k => {
        const d = new Date(k.createdAt?.seconds ? k.createdAt.seconds * 1000 : k.createdAt);
        return d >= yesterday && d < today;
      });
      const weekKnocks = knocks.filter(k => new Date(k.createdAt?.seconds ? k.createdAt.seconds * 1000 : k.createdAt) >= weekAgo);

      const contacts = yesterdayKnocks.filter(k => ['appointment', 'callback', 'not_interested', 'already_has_contractor'].includes(k.disposition));
      const appointments = yesterdayKnocks.filter(k => k.disposition === 'appointment');
      const followUpsDue = knocks.filter(k => {
        const fup = k.followUpDate ? new Date(k.followUpDate.seconds ? k.followUpDate.seconds * 1000 : k.followUpDate) : null;
        return fup && fup <= new Date() && !k.convertedToLead;
      });

      return {
        todayKnocks: todayKnocks.length,
        yesterdayKnocks: yesterdayKnocks.length,
        weekKnocks: weekKnocks.length,
        weekAvg: Math.round(weekKnocks.length / 7),
        contactRate: yesterdayKnocks.length > 0 ? Math.round(contacts.length / yesterdayKnocks.length * 100) : 0,
        closeRate: contacts.length > 0 ? Math.round(appointments.length / contacts.length * 100) : 0,
        followUpsDue: followUpsDue.length,
        followUps: followUpsDue.slice(0, 5),
        totalKnocks: knocks.length
      };
    } catch (e) { return null; }
  }

  function getGamificationData() {
    if (window.D2D && window.D2D.getGamification) {
      return window.D2D.getGamification();
    }
    return null;
  }

  function getStormData() {
    if (window.StormCenter) {
      return {
        alerts: window.StormCenter.getAlerts ? window.StormCenter.getAlerts() : [],
        zones: window.StormCenter.getZones ? window.StormCenter.getZones() : []
      };
    }
    return { alerts: [], zones: [] };
  }

  function getDealData() {
    if (window.CloseBoard) {
      const deals = window.CloseBoard.getDeals ? window.CloseBoard.getDeals() : [];
      // Mirror Close Board's own close definition (accepted|signed|scheduled).
      // A remote homeowner acceptance lands as 'accepted' — this briefing used
      // to drop it from signed AND count it as active, so a real close showed as
      // still-open. Active = anything not closed and not expired.
      return {
        active: deals.filter(d => !['accepted', 'signed', 'scheduled', 'expired'].includes(d.status)).length,
        pending: deals.filter(d => d.status === 'sent' || d.status === 'viewed').length,
        signed: deals.filter(d => ['accepted', 'signed', 'scheduled'].includes(d.status)).length
      };
    }
    return { active: 0, pending: 0, signed: 0 };
  }

  // ============================================================================
  // COACHING ENGINE
  // ============================================================================

  function generateCoachingTips(metrics) {
    const tips = [];

    if (!metrics) {
      tips.push(COACHING_TIPS.great_performance[0]);
      return tips;
    }

    // Analyze performance and pick relevant tips
    if (metrics.yesterdayKnocks < (metrics.weekAvg * 0.7) && metrics.yesterdayKnocks > 0) {
      tips.push(...COACHING_TIPS.low_knock_volume);
    }
    if (metrics.contactRate < 30 && metrics.yesterdayKnocks > 5) {
      tips.push(...COACHING_TIPS.low_contact_rate);
    }
    if (metrics.closeRate < 20 && metrics.contactRate > 30) {
      tips.push(...COACHING_TIPS.low_close_rate);
    }
    if (metrics.contactRate > 50 && metrics.closeRate > 30) {
      tips.push(...COACHING_TIPS.great_performance);
    }
    if (metrics.followUpsDue > 3) {
      tips.push(...COACHING_TIPS.follow_up_heavy);
    }

    // Storm opportunity
    const storms = getStormData();
    if (storms.alerts.length > 0 || storms.zones.filter(z => z.status === 'active').length > 0) {
      tips.push(...COACHING_TIPS.storm_opportunity);
    }

    // If no specific tips, give general encouragement
    if (tips.length === 0) {
      tips.push({ cat: 'mindset', text: 'New day, fresh start. Set your target, hit the streets, and remember — you only need one yes to make today worth it.' });
    }

    return tips.slice(0, 3); // Max 3 tips per day
  }

  // ============================================================================
  // BRIEFING GENERATOR
  // ============================================================================

  async function generateBriefing() {
    if (isGenerating) return;
    isGenerating = true;
    render();

    const metrics = getD2DMetrics();
    const gamify = getGamificationData();
    const storms = getStormData();
    const deals = getDealData();
    const tips = generateCoachingTips(metrics);

    const briefing = {
      date: todayKey(),
      generatedAt: new Date().toISOString(),
      greeting: getGreeting(),
      metrics,
      gamification: gamify,
      storms: {
        activeAlerts: storms.alerts.length,
        activeZones: storms.zones.filter(z => z.status !== 'completed').length,
        canvassingZones: storms.zones.filter(z => z.status === 'canvassing').length
      },
      deals,
      coachingTips: tips,
      todayPlan: generateTodayPlan(metrics, storms, deals),
      motivationalQuote: getMotivationalQuote()
    };

    // Replace or add today's briefing
    briefings = briefings.filter(b => b.date !== todayKey());
    briefings.unshift(briefing);
    todayBriefing = briefing;
    saveBriefings();

    isGenerating = false;
    render();
    return briefing;
  }

  function getGreeting() {
    const hour = new Date().getHours();
    const name = window._user?.displayName?.split(' ')[0] || 'Rep';
    if (hour < 12) return `Good morning, ${name}`;
    if (hour < 17) return `Good afternoon, ${name}`;
    return `Good evening, ${name}`;
  }

  function generateTodayPlan(metrics, storms, deals) {
    const plan = [];
    const hasFollowUps = metrics && metrics.followUpsDue > 0;
    const hasStorms = storms.alerts.length > 0 || storms.zones.filter(z => z.status === 'active').length > 0;
    const hasDeals = deals.pending > 0;

    // Morning block (8-10am)
    if (hasFollowUps) {
      plan.push({ time: '8:00 – 10:00am', action: `📞 Follow up on ${metrics.followUpsDue} overdue contacts`, priority: 'high', type: 'followup' });
    } else {
      plan.push({ time: '8:00 – 10:00am', action: '🎯 Review yesterday\'s knocks, prep materials, plan route', priority: 'normal', type: 'prep' });
    }

    // Mid-morning (10am-12pm)
    if (hasStorms) {
      plan.push({ time: '10:00am – 12:00pm', action: '🌩️ Drive storm zones, photograph damage, start knocking affected areas', priority: 'high', type: 'storm' });
    } else {
      plan.push({ time: '10:00am – 12:00pm', action: '🚪 Morning knock block — focus on previously "not home" addresses', priority: 'normal', type: 'knock' });
    }

    // Afternoon (1-4pm)
    if (hasDeals) {
      plan.push({ time: '1:00 – 4:00pm', action: `📋 ${deals.pending} deals need attention — follow up on viewed estimates`, priority: 'high', type: 'deals' });
    } else {
      plan.push({ time: '1:00 – 4:00pm', action: '🚪 Afternoon knock block — new territory expansion', priority: 'normal', type: 'knock' });
    }

    // Peak hours (4-7pm)
    plan.push({ time: '4:00 – 7:00pm', action: '🔥 PEAK HOURS — maximum door knocking, highest contact rates', priority: 'critical', type: 'knock' });

    // Evening (7-8pm)
    plan.push({ time: '7:00 – 8:00pm', action: '📝 Log today\'s results, set tomorrow\'s appointments, send follow-up texts', priority: 'normal', type: 'admin' });

    return plan;
  }

  function getMotivationalQuote() {
    const quotes = [
      { text: 'The doors you don\'t knock on are the deals you\'ll never close.', author: 'D2D Sales Wisdom' },
      { text: 'Every "no" is one step closer to "yes." Track both — the ratio matters more than the number.', author: 'Top Producer Mindset' },
      { text: 'You don\'t need to be the best closer. You need to be the most consistent knocker.', author: 'Volume Wins' },
      { text: 'Storm chasers don\'t wait for perfect conditions. They create opportunities from chaos.', author: 'NBD Philosophy' },
      { text: 'Your competition hit snooze this morning. You didn\'t. That\'s your edge.', author: 'Early Bird Advantage' },
      { text: 'The homeowner doesn\'t care about your product. They care about their problem. Lead with their pain.', author: 'Customer First' },
      { text: 'A follow-up call costs nothing and converts 3x better than a cold knock. Do your follow-ups first.', author: 'Smart Sales' },
      { text: 'The best time to knock was yesterday. The second best time is right now.', author: 'No Excuses' }
    ];
    return quotes[Math.floor(Math.random() * quotes.length)];
  }

  // ============================================================================
  // UI RENDERING
  // ============================================================================

  // CSP-safe delegated click dispatcher. The view's inline onclick
  // attributes set via innerHTML were blocked by the prod CSP
  // `script-src-attr 'none'`, leaving every button dead. data-* attrs
  // + a single property handler on the container restore the wiring.
  function attachRepOsHandlers(scroll) {
    scroll.onclick = function (ev) {
      const target = ev.target.closest('[data-repos-action], [data-repos-goto]');
      if (!target) return;
      if (target.dataset.reposAction) {
        const fn = window.RepOS && window.RepOS[target.dataset.reposAction];
        if (typeof fn === 'function') {
          try { fn(); } catch (e) { console.error('[rep-os] dispatch failed:', e); }
        }
      } else if (target.dataset.reposGoto) {
        const dest = target.dataset.reposGoto;
        if (typeof window.goTo === 'function') window.goTo(dest);
        const d2dTab = target.dataset.reposD2dTab;
        if (d2dTab && window.D2D && typeof window.D2D.setTab === 'function') {
          window.D2D.setTab(d2dTab);
        }
      }
    };
  }

  function render() {
    const container = document.getElementById('view-repos');
    if (!container) return;
    const scroll = container.querySelector('.view-scroll') || container;

    if (!todayBriefing && !isGenerating) {
      scroll.innerHTML = renderWelcome();
      attachRepOsHandlers(scroll);
      return;
    }

    if (isGenerating) {
      scroll.innerHTML = `
        <div class="rpx-tacenter-p60px20px">
          <div class="rpx-fs40px-mb16px">🧠</div>
          <div class="rpx-fs18px-w700-ct">Generating Your Daily Briefing...</div>
          <div class="rpx-fs12px-cm-mt6px">Analyzing your performance and opportunities</div>
        </div>
      `;
      return;
    }

    const b = todayBriefing;
    const m = b.metrics;

    let html = `<div class="rpx-p16px20px">`;

    // Header
    html += `
      <div class="rpx-dflex-aicenter-jcspacebet">
        <div>
          <div class="rpx-fs22px-w800-ffbarlowco">🧠 REP OS</div>
          <div class="rpx-fs12px-cm-mt2px">${fmtDate(new Date())}</div>
        </div>
        <button data-repos-action="regenerate" class="rpx-p8px14px-bgs2-bd1pxsolid">🔄 Refresh</button>
      </div>
    `;

    // Greeting + Quote
    html += `
      <div class="rpx-bglineargr-bd1pxsolid-r12px">
        <div class="rpx-fs18px-w700-ct-2">${esc(b.greeting)} 👋</div>
        <div class="rpx-fs12px-cm-mt6px-2">"${esc(b.motivationalQuote.text)}"</div>
        <div class="rpx-fs10px-corange-mt4px">— ${esc(b.motivationalQuote.author)}</div>
      </div>
    `;

    // Performance Snapshot
    if (m) {
      html += `
        <div class="ros-perf-row rpx-dflex-gap8px-mb10px">
          <div class="rpx-fx1-minw70px-bgs2">
            <div class="rpx-fs20px-w700-ct">${m.yesterdayKnocks}</div>
            <div class="rpx-fs9px-cm-ttuppercas">Yesterday</div>
          </div>
          <div class="rpx-fx1-minw70px-bgs2">
            <div class="rpx-fs20px-w700-cblue">${m.contactRate}%</div>
            <div class="rpx-fs9px-cm-ttuppercas">Contact</div>
          </div>
          <div class="rpx-fx1-minw70px-bgs2">
            <div class="rpx-fs20px-w700-cgreen">${m.closeRate}%</div>
            <div class="rpx-fs9px-cm-ttuppercas">Close</div>
          </div>
          <div class="rpx-fx1-minw70px-bgs2">
            <div style="font-size:20px;font-weight:700;color:${m.followUpsDue > 0 ? 'var(--red)' : 'var(--m)'};">${m.followUpsDue}</div>
            <div class="rpx-fs9px-cm-ttuppercas">Follow-ups</div>
          </div>
        </div>
      `;
    }

    // Gamification streak
    if (b.gamification) {
      html += `
        <div class="rpx-bgs2-bd1pxsolid-r10px-2">
          <div class="rpx-fs28px">${b.gamification.currentMilestone?.badge || '🔥'}</div>
          <div class="rpx-fx1">
            <div class="rpx-fs14px-w700-ct">${b.gamification.streak || 0} Day Streak</div>
            <div class="rpx-fs11px-cm">${b.gamification.completedChallenges || 0}/${b.gamification.totalChallenges || 0} daily challenges completed</div>
          </div>
          <button data-repos-goto="d2d" data-repos-d2d-tab="gamify" class="rpx-p6px12px-bgorange-cwhite">VIEW</button>
        </div>
      `;
    }

    // Storm Alerts
    if (b.storms.activeAlerts > 0 || b.storms.activeZones > 0) {
      html += `
        <div class="rpx-bgff6d0015-bd1pxsolid-r10px">
          <div class="rpx-fs12px-w700-cff6d00">⛈️ STORM OPPORTUNITY</div>
          <div class="rpx-fs13px-ct">${b.storms.activeAlerts} active alert${b.storms.activeAlerts !== 1 ? 's' : ''} · ${b.storms.activeZones} storm zone${b.storms.activeZones !== 1 ? 's' : ''} ready to canvass</div>
          <button data-repos-goto="storm" class="rpx-mt8px-p6px14px-bgff6d00">OPEN STORM CENTER →</button>
        </div>
      `;
    }

    // Deal Pipeline
    if (b.deals.active > 0 || b.deals.pending > 0) {
      html += `
        <div class="rpx-bgs2-bd1pxsolid-r10px">
          <div class="rpx-fs12px-w700-ct">📋 Deal Pipeline</div>
          <div class="rpx-dflex-gap16px-fs12px">
            <span class="rpx-cblue">${b.deals.active} active</span>
            <span class="rpx-cffab00">${b.deals.pending} awaiting response</span>
            <span class="rpx-cgreen">${b.deals.signed} signed</span>
          </div>
          ${b.deals.pending > 0 ? `<button data-repos-goto="closeboard" class="rpx-mt8px-p6px14px-bgblue">CHECK DEALS →</button>` : ''}
        </div>
      `;
    }

    // Coaching Tips
    if (b.coachingTips && b.coachingTips.length > 0) {
      html += `
        <div class="rpx-fs11px-w700-corange">💡 Today's Coaching</div>
        ${b.coachingTips.map(tip => {
          const cat = COACHING_CATEGORIES[tip.cat] || COACHING_CATEGORIES.mindset;
          return `
            <div class="rpx-bgs2-bd1pxsolid-r10px-3">
              <div class="rpx-fs10px-w700-corange">${cat.icon} ${cat.label}</div>
              <div class="rpx-fs13px-ct-lh15">${esc(tip.text)}</div>
            </div>
          `;
        }).join('')}
      `;
    }

    // Today's Plan
    if (b.todayPlan && b.todayPlan.length > 0) {
      html += `
        <div class="rpx-fs11px-w700-ct">📅 Today's Plan</div>
        ${b.todayPlan.map(p => {
          const prioColor = p.priority === 'critical' ? '#ff1744' : p.priority === 'high' ? '#ff6d00' : 'var(--m)';
          return `
            <div class="rpx-dflex-gap10px-aiflexstar">
              <div style="min-width:100px;font-size:11px;font-weight:600;color:${prioColor};">${p.time}</div>
              <div class="rpx-fx1-fs12px-ct">${esc(p.action)}</div>
            </div>
          `;
        }).join('')}
      `;
    }

    // Follow-ups due
    if (m && m.followUps && m.followUps.length > 0) {
      html += `
        <div class="rpx-fs11px-w700-cred">📞 Follow-ups Due</div>
        ${m.followUps.map(f => `
          <div class="rpx-dflex-aicenter-gap10px">
            <div class="rpx-fx1">
              <div class="rpx-fs13px-w600-ct">${esc(f.contactName || f.address || 'Unknown')}</div>
              <div class="rpx-fs11px-cm">${esc(f.address || '')} ${f.phone ? '· ' + esc(f.phone) : ''}</div>
            </div>
            ${f.phone ? `<a href="tel:${f.phone.replace(/\D/g, '')}" class="rpx-p6px10px-bggreen-cwhite">📞 Call</a>` : ''}
          </div>
        `).join('')}
      `;
    }

    // Quick Actions
    html += `
      <div class="rpx-fs11px-w700-ct-2">⚡ Quick Actions</div>
      <div class="rpx-dgrid-gtcrepeat21-gap8px">
        <button data-repos-goto="d2d" class="rpx-p14px-bgs2-bd1pxsolid">🚪 Start Knocking</button>
        <button data-repos-goto="storm" class="rpx-p14px-bgs2-bd1pxsolid">⛈️ Storm Center</button>
        <button data-repos-goto="closeboard" class="rpx-p14px-bgs2-bd1pxsolid">📋 Close Board</button>
        <button data-repos-goto="training" class="rpx-p14px-bgs2-bd1pxsolid">🎓 Sales Practice</button>
      </div>
    `;

    html += '</div>';
    scroll.innerHTML = html;
    attachRepOsHandlers(scroll);
  }

  function renderWelcome() {
    return `
      <div class="rpx-p20px-tacenter">
        <div class="rpx-mt40px">
          <div class="rpx-fs60px-mb16px">🧠</div>
          <div class="rpx-fs24px-w800-ffbarlowco">REP OS</div>
          <div class="rpx-fs14px-cm-mt6px">Your AI-powered daily briefing. Follow-ups, coaching, and optimized route — all in one view.</div>
          <button data-repos-action="generate" class="rpx-mt20px-p14px28px-bgorange">
            ⚡ GENERATE TODAY'S BRIEFING
          </button>
        </div>
      </div>
    `;
  }

  // ============================================================================
  // INIT & PUBLIC API
  // ============================================================================

  function init() {
    loadBriefings();
    render();
    // Auto-generate if no briefing today
    if (!todayBriefing) {
      // Don't auto-generate — let user click the button
    }
  }

  async function regenerate() {
    todayBriefing = null;
    await generateBriefing();
  }

  window.RepOS = {
    init,
    render,
    generate: generateBriefing,
    regenerate,
    getBriefing: () => todayBriefing,
    getBriefings: () => briefings
  };

})();
