/**
 * NBD Pro — Rep OS v1
 * AI-powered daily briefing & coaching engine
 * Morning auto-brief: weather, follow-ups, coaching, hot neighborhoods, route
 * Ties together D2D, Sales Training, Gamification, and Joe AI
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS
  // ============================================================================

  const BRIEFING_STORAGE_KEY = 'nbd_rep_briefings';
  const WEATHER_API = 'https://api.openweathermap.org/data/2.5/weather';
  const FORECAST_API = 'https://api.openweathermap.org/data/2.5/forecast';

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
      { cat: 'closing', text: 'After a storm, the close is easier: "Most insurance policies cover this 100%. We handle the entire process — you just pay your deductible."' }
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

  async function getWeatherData() {
    const key = localStorage.getItem('nbd_weather_key') || localStorage.getItem('openweather_key');
    if (!key) return null;

    try {
      let lat = 39.1031, lng = -84.5120; // Cincinnati default
      if (navigator.geolocation) {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 3000 });
        }).catch(() => null);
        if (pos) { lat = pos.coords.latitude; lng = pos.coords.longitude; }
      }

      const resp = await fetch(`${WEATHER_API}?lat=${lat}&lon=${lng}&appid=${key}&units=imperial`);
      if (!resp.ok) return null;
      const data = await resp.json();

      // Also get forecast for canvassing window
      const fResp = await fetch(`${FORECAST_API}?lat=${lat}&lon=${lng}&appid=${key}&units=imperial&cnt=8`);
      const fData = fResp.ok ? await fResp.json() : null;

      return {
        temp: Math.round(data.main.temp),
        feelsLike: Math.round(data.main.feels_like),
        description: data.weather?.[0]?.description || 'Unknown',
        icon: data.weather?.[0]?.icon,
        humidity: data.main.humidity,
        windSpeed: Math.round(data.wind?.speed || 0),
        city: data.name,
        canvassingWindow: getCanvassingWindow(fData),
        isGoodForKnocking: data.main.temp > 40 && data.main.temp < 95 && (data.wind?.speed || 0) < 25 && !data.weather?.[0]?.main?.includes('Rain')
      };
    } catch (e) { return null; }
  }

  function getCanvassingWindow(forecast) {
    if (!forecast?.list) return { label: '10am – 7pm', quality: 'good' };

    const windows = forecast.list.map(f => ({
      time: new Date(f.dt * 1000),
      temp: f.main.temp,
      rain: f.rain?.['3h'] || 0,
      wind: f.wind?.speed || 0,
      weather: f.weather?.[0]?.main || ''
    }));

    const goodWindows = windows.filter(w => {
      const hour = w.time.getHours();
      return hour >= 10 && hour <= 19 && w.temp > 40 && w.temp < 95 && w.rain === 0 && w.wind < 20;
    });

    if (goodWindows.length >= 3) {
      const start = goodWindows[0].time;
      const end = goodWindows[goodWindows.length - 1].time;
      return {
        label: `${fmtTime(start)} – ${fmtTime(end)}`,
        quality: 'excellent',
        hours: goodWindows.length
      };
    } else if (goodWindows.length >= 1) {
      return { label: `${fmtTime(goodWindows[0].time)} – limited window`, quality: 'fair', hours: goodWindows.length };
    }
    return { label: 'Poor conditions — consider follow-up calls instead', quality: 'poor', hours: 0 };
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
    const weather = await getWeatherData();
    const tips = generateCoachingTips(metrics);

    const briefing = {
      date: todayKey(),
      generatedAt: new Date().toISOString(),
      greeting: getGreeting(),
      weather,
      metrics,
      gamification: gamify,
      storms: {
        activeAlerts: storms.alerts.length,
        activeZones: storms.zones.filter(z => z.status !== 'completed').length,
        canvassingZones: storms.zones.filter(z => z.status === 'canvassing').length
      },
      deals,
      coachingTips: tips,
      todayPlan: generateTodayPlan(metrics, weather, storms, deals),
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

  function generateTodayPlan(metrics, weather, storms, deals) {
    const plan = [];
    const hasFollowUps = metrics && metrics.followUpsDue > 0;
    const hasStorms = storms.alerts.length > 0 || storms.zones.filter(z => z.status === 'active').length > 0;
    const hasDeals = deals.pending > 0;
    const goodWeather = weather?.isGoodForKnocking !== false;

    // Morning block (8-10am)
    if (hasFollowUps) {
      plan.push({ time: '8:00 – 10:00am', action: `📞 Follow up on ${metrics.followUpsDue} overdue contacts`, priority: 'high', type: 'followup' });
    } else {
      plan.push({ time: '8:00 – 10:00am', action: '🎯 Review yesterday\'s knocks, prep materials, plan route', priority: 'normal', type: 'prep' });
    }

    // Mid-morning (10am-12pm)
    if (hasStorms) {
      plan.push({ time: '10:00am – 12:00pm', action: '🌩️ Drive storm zones, photograph damage, start knocking affected areas', priority: 'high', type: 'storm' });
    } else if (goodWeather) {
      plan.push({ time: '10:00am – 12:00pm', action: '🚪 Morning knock block — focus on previously "not home" addresses', priority: 'normal', type: 'knock' });
    } else {
      plan.push({ time: '10:00am – 12:00pm', action: '📋 Indoor work — update CRM, send estimates, follow up on deals', priority: 'normal', type: 'admin' });
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
        <div style="text-align:center;padding:60px 20px;">
          <div style="font-size:40px;margin-bottom:16px;">🧠</div>
          <div style="font-size:18px;font-weight:700;color:var(--t);font-family:'Barlow Condensed',sans-serif;">Generating Your Daily Briefing...</div>
          <div style="font-size:12px;color:var(--m);margin-top:6px;">Analyzing your performance, weather, and opportunities</div>
        </div>
      `;
      return;
    }

    const b = todayBriefing;
    const w = b.weather;
    const m = b.metrics;

    let html = `<div style="padding:16px 20px 20px;">`;

    // Header
    html += `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <div style="font-size:22px;font-weight:800;font-family:'Barlow Condensed',sans-serif;color:var(--t);letter-spacing:.02em;">🧠 REP OS</div>
          <div style="font-size:12px;color:var(--m);margin-top:2px;">${fmtDate(new Date())}</div>
        </div>
        <button data-repos-action="regenerate" style="padding:8px 14px;background:var(--s2);border:1px solid var(--br);color:var(--t);border-radius:8px;font-size:11px;font-weight:600;font-family:'Barlow Condensed',sans-serif;cursor:pointer;">🔄 Refresh</button>
      </div>
    `;

    // Greeting + Quote
    html += `
      <div style="background:linear-gradient(135deg,#BD572820,var(--s2));border:1px solid #BD572840;border-radius:12px;padding:16px;margin-bottom:14px;">
        <div style="font-size:18px;font-weight:700;color:var(--t);">${esc(b.greeting)} 👋</div>
        <div style="font-size:12px;color:var(--m);margin-top:6px;font-style:italic;line-height:1.5;">"${esc(b.motivationalQuote.text)}"</div>
        <div style="font-size:10px;color:var(--orange);margin-top:4px;">— ${esc(b.motivationalQuote.author)}</div>
      </div>
    `;

    // Weather Card
    if (w) {
      const windowColor = w.canvassingWindow?.quality === 'excellent' ? 'var(--green)' :
                          w.canvassingWindow?.quality === 'fair' ? '#ffab00' : 'var(--red)';
      html += `
        <div style="background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:14px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div>
              <div style="font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.06em;">☁️ Weather — ${esc(w.city || 'Your Area')}</div>
              <div style="font-size:22px;font-weight:700;color:var(--t);margin-top:4px;">${w.temp}°F <span style="font-size:12px;font-weight:400;color:var(--m);">feels ${w.feelsLike}°</span></div>
              <div style="font-size:12px;color:var(--m);text-transform:capitalize;">${esc(w.description)} · 💨 ${w.windSpeed}mph · 💧 ${w.humidity}%</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:10px;color:${windowColor};font-weight:700;text-transform:uppercase;">${w.isGoodForKnocking ? '✅ GOOD FOR KNOCKING' : '⚠️ CHECK CONDITIONS'}</div>
              <div style="font-size:11px;color:var(--m);margin-top:4px;">Window: ${w.canvassingWindow?.label || '10am-7pm'}</div>
            </div>
          </div>
        </div>
      `;
    }

    // Performance Snapshot
    if (m) {
      html += `
        <div class="ros-perf-row" style="display:flex;gap:8px;margin-bottom:10px;overflow-x:auto;">
          <div style="flex:1;min-width:70px;background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:10px;text-align:center;">
            <div style="font-size:20px;font-weight:700;color:var(--t);">${m.yesterdayKnocks}</div>
            <div style="font-size:9px;color:var(--m);text-transform:uppercase;">Yesterday</div>
          </div>
          <div style="flex:1;min-width:70px;background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:10px;text-align:center;">
            <div style="font-size:20px;font-weight:700;color:var(--blue);">${m.contactRate}%</div>
            <div style="font-size:9px;color:var(--m);text-transform:uppercase;">Contact</div>
          </div>
          <div style="flex:1;min-width:70px;background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:10px;text-align:center;">
            <div style="font-size:20px;font-weight:700;color:var(--green);">${m.closeRate}%</div>
            <div style="font-size:9px;color:var(--m);text-transform:uppercase;">Close</div>
          </div>
          <div style="flex:1;min-width:70px;background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:10px;text-align:center;">
            <div style="font-size:20px;font-weight:700;color:${m.followUpsDue > 0 ? 'var(--red)' : 'var(--m)'};">${m.followUpsDue}</div>
            <div style="font-size:9px;color:var(--m);text-transform:uppercase;">Follow-ups</div>
          </div>
        </div>
      `;
    }

    // Gamification streak
    if (b.gamification) {
      html += `
        <div style="background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:12px;margin-bottom:10px;display:flex;align-items:center;gap:12px;">
          <div style="font-size:28px;">${b.gamification.currentMilestone?.badge || '🔥'}</div>
          <div style="flex:1;">
            <div style="font-size:14px;font-weight:700;color:var(--t);">${b.gamification.streak || 0} Day Streak</div>
            <div style="font-size:11px;color:var(--m);">${b.gamification.completedChallenges || 0}/${b.gamification.totalChallenges || 0} daily challenges completed</div>
          </div>
          <button data-repos-goto="d2d" data-repos-d2d-tab="gamify" style="padding:6px 12px;background:var(--orange);color:white;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;">VIEW</button>
        </div>
      `;
    }

    // Storm Alerts
    if (b.storms.activeAlerts > 0 || b.storms.activeZones > 0) {
      html += `
        <div style="background:#ff6d0015;border:1px solid #ff6d0040;border-radius:10px;padding:14px;margin-bottom:10px;">
          <div style="font-size:12px;font-weight:700;color:#ff6d00;margin-bottom:6px;">⛈️ STORM OPPORTUNITY</div>
          <div style="font-size:13px;color:var(--t);">${b.storms.activeAlerts} active alert${b.storms.activeAlerts !== 1 ? 's' : ''} · ${b.storms.activeZones} storm zone${b.storms.activeZones !== 1 ? 's' : ''} ready to canvass</div>
          <button data-repos-goto="storm" style="margin-top:8px;padding:6px 14px;background:#ff6d00;color:white;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">OPEN STORM CENTER →</button>
        </div>
      `;
    }

    // Deal Pipeline
    if (b.deals.active > 0 || b.deals.pending > 0) {
      html += `
        <div style="background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:14px;margin-bottom:10px;">
          <div style="font-size:12px;font-weight:700;color:var(--t);margin-bottom:6px;">📋 Deal Pipeline</div>
          <div style="display:flex;gap:16px;font-size:12px;">
            <span style="color:var(--blue);">${b.deals.active} active</span>
            <span style="color:#ffab00;">${b.deals.pending} awaiting response</span>
            <span style="color:var(--green);">${b.deals.signed} signed</span>
          </div>
          ${b.deals.pending > 0 ? `<button data-repos-goto="closeboard" style="margin-top:8px;padding:6px 14px;background:var(--blue);color:white;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;">CHECK DEALS →</button>` : ''}
        </div>
      `;
    }

    // Coaching Tips
    if (b.coachingTips && b.coachingTips.length > 0) {
      html += `
        <div style="font-size:11px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px;">💡 Today's Coaching</div>
        ${b.coachingTips.map(tip => {
          const cat = COACHING_CATEGORIES[tip.cat] || COACHING_CATEGORIES.mindset;
          return `
            <div style="background:var(--s2);border:1px solid var(--br);border-radius:10px;padding:12px;margin-bottom:8px;">
              <div style="font-size:10px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">${cat.icon} ${cat.label}</div>
              <div style="font-size:13px;color:var(--t);line-height:1.5;">${esc(tip.text)}</div>
            </div>
          `;
        }).join('')}
      `;
    }

    // Today's Plan
    if (b.todayPlan && b.todayPlan.length > 0) {
      html += `
        <div style="font-size:11px;font-weight:700;color:var(--t);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px;">📅 Today's Plan</div>
        ${b.todayPlan.map(p => {
          const prioColor = p.priority === 'critical' ? '#ff1744' : p.priority === 'high' ? '#ff6d00' : 'var(--m)';
          return `
            <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--br);">
              <div style="min-width:100px;font-size:11px;font-weight:600;color:${prioColor};">${p.time}</div>
              <div style="flex:1;font-size:12px;color:var(--t);">${esc(p.action)}</div>
            </div>
          `;
        }).join('')}
      `;
    }

    // Follow-ups due
    if (m && m.followUps && m.followUps.length > 0) {
      html += `
        <div style="font-size:11px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.06em;margin:14px 0 8px;">📞 Follow-ups Due</div>
        ${m.followUps.map(f => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--s2);border:1px solid var(--br);border-radius:8px;margin-bottom:6px;">
            <div style="flex:1;">
              <div style="font-size:13px;font-weight:600;color:var(--t);">${esc(f.contactName || f.address || 'Unknown')}</div>
              <div style="font-size:11px;color:var(--m);">${esc(f.address || '')} ${f.phone ? '· ' + esc(f.phone) : ''}</div>
            </div>
            ${f.phone ? `<a href="tel:${f.phone.replace(/\D/g, '')}" style="padding:6px 10px;background:var(--green);color:white;border:none;border-radius:6px;font-size:10px;font-weight:700;text-decoration:none;">📞 Call</a>` : ''}
          </div>
        `).join('')}
      `;
    }

    // Quick Actions
    html += `
      <div style="font-size:11px;font-weight:700;color:var(--t);text-transform:uppercase;letter-spacing:.06em;margin:16px 0 8px;">⚡ Quick Actions</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">
        <button data-repos-goto="d2d" style="padding:14px;background:var(--s2);border:1px solid var(--br);border-radius:10px;font-size:12px;font-weight:600;color:var(--t);cursor:pointer;font-family:'Barlow Condensed',sans-serif;letter-spacing:.03em;">🚪 Start Knocking</button>
        <button data-repos-goto="storm" style="padding:14px;background:var(--s2);border:1px solid var(--br);border-radius:10px;font-size:12px;font-weight:600;color:var(--t);cursor:pointer;font-family:'Barlow Condensed',sans-serif;letter-spacing:.03em;">⛈️ Storm Center</button>
        <button data-repos-goto="closeboard" style="padding:14px;background:var(--s2);border:1px solid var(--br);border-radius:10px;font-size:12px;font-weight:600;color:var(--t);cursor:pointer;font-family:'Barlow Condensed',sans-serif;letter-spacing:.03em;">📋 Close Board</button>
        <button data-repos-goto="training" style="padding:14px;background:var(--s2);border:1px solid var(--br);border-radius:10px;font-size:12px;font-weight:600;color:var(--t);cursor:pointer;font-family:'Barlow Condensed',sans-serif;letter-spacing:.03em;">🎓 Sales Practice</button>
      </div>
    `;

    html += '</div>';
    scroll.innerHTML = html;
    attachRepOsHandlers(scroll);
  }

  function renderWelcome() {
    return `
      <div style="padding:20px;text-align:center;">
        <div style="margin-top:40px;">
          <div style="font-size:60px;margin-bottom:16px;">🧠</div>
          <div style="font-size:24px;font-weight:800;font-family:'Barlow Condensed',sans-serif;color:var(--t);">REP OS</div>
          <div style="font-size:14px;color:var(--m);margin-top:6px;max-width:320px;margin-left:auto;margin-right:auto;line-height:1.5;">Your AI-powered daily briefing. Weather, follow-ups, coaching, and optimized route — all in one view.</div>
          <button data-repos-action="generate" style="margin-top:20px;padding:14px 28px;background:var(--orange,#BD5728);color:white;border:none;border-radius:10px;font-size:14px;font-weight:700;font-family:'Barlow Condensed',sans-serif;cursor:pointer;letter-spacing:.04em;text-transform:uppercase;">
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
