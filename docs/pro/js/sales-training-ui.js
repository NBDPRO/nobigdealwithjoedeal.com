/**
 * sales-training-ui.js — render() pipeline + per-mode renderers
 *
 * Step 4f (2026-05-17): UI half of the split. Reads state from
 * window._SalesTrainingState (published by sales-training-engine.js)
 * and provides:
 *   - render() top-level dispatcher (called by engine on every state change)
 *   - renderMenu, renderScenarioNode, renderFeedback,
 *     renderScenarioResults, renderRapidFire, renderRapidResults,
 *     renderProfile
 *
 * Must load AFTER engine so the state object is hydrated.
 */
(function() {
  'use strict';

  const state = window._SalesTrainingState || (window._SalesTrainingState = {});

  // Defensive: if engine didn't load first, leave loud breadcrumbs but
  // still publish a render() stub so engine doesn't crash on first call.
  if (typeof state.startScenario !== 'function') {
    console.error('[sales-training-ui] engine module missing — load sales-training-engine.js first');
  }

  function render() {
    const container = document.getElementById('trainingContent');
    if (!container) return;

    switch (state.currentMode) {
      case 'menu':       container.innerHTML = renderMenu(); break;
      case 'scenario':   container.innerHTML = renderScenarioNode(); break;
      case 'feedback':   container.innerHTML = renderFeedback(); break;
      case 'results':    container.innerHTML = renderScenarioResults(); break;
      case 'rapid':      container.innerHTML = renderRapidFire(); break;
      case 'rapid_results': container.innerHTML = renderRapidResults(); break;
      case 'profile':    container.innerHTML = renderProfile(); break;
    }
  }
  function renderMenu() {
    const scenarioCards = state.SCENARIOS.map(s => {
      // Check history for best score
      const best = state.trainingHistory.filter(h => h.scenarioId === s.id).sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
      const bestStars = best ? best.stars || 0 : 0;
      const attempts = state.trainingHistory.filter(h => h.scenarioId === s.id).length;

      return `
        <div class="training-card" data-st-action="startScenario" data-st-id="${s.id}">
          <div class="tc-header">
            <span class="tc-icon">${s.icon}</span>
            <div class="tc-diff" style="color:color-mix(in srgb, ${s.diffColor} 50%, var(--t, #e8eaf0));">${s.difficulty}</div>
          </div>
          <div class="tc-title">${s.title}</div>
          <div class="tc-sub">${s.subtitle}</div>
          <div class="tc-meta">
            <span>⏱ ${s.estimatedTime}</span>
            <span>${s.skillFocus.map(t => state.SKILL_TAGS[t]?.icon || '').join(' ')}</span>
          </div>
          ${bestStars > 0 ? `<div class="tc-best">${state.starsHTML(bestStars, 14)} <span class="tc-attempts">${attempts} attempt${attempts !== 1 ? 's' : ''}</span></div>` : '<div class="tc-best tc-new">NEW</div>'}
        </div>`;
    }).join('');

    // Rapid fire stats
    const rapidSessions = state.trainingHistory.filter(h => h.type === 'rapid');
    const rapidBest = rapidSessions.sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];

    return `
      <div class="training-menu">
        <!-- Header -->
        <div class="tm-header">
          <div>
            <div class="tm-title">Sales Training</div>
            <div class="tm-sub">Sharpen your pitch. Handle any objection. Close more doors.</div>
          </div>
          <div class="tm-actions">
            <button class="btn btn-ghost" data-st-action="showProfile" style="font-size:12px;padding:7px 14px;">📊 My Profile</button>
          </div>
        </div>

        <!-- Rapid Fire Banner -->
        <div class="rapid-banner" data-st-action="startRapidFire">
          <div class="rb-left">
            <div class="rb-icon">⚡</div>
            <div>
              <div class="rb-title">Objection Obliterator</div>
              <div class="rb-sub">${state.OBJECTIONS.length} objections · Rapid-fire drill · Beat your best streak</div>
            </div>
          </div>
          <div class="rb-right">
            ${rapidBest ? `<div class="rb-best">Best: ${rapidBest.pct}% · Streak: ${rapidBest.bestStreak || 0}</div>` : '<div class="rb-best rb-new">START</div>'}
            <div class="rb-arrow">→</div>
          </div>
        </div>

        <!-- Scenario Cards -->
        <div class="tm-section-label">PITCH PERFECTOR — Scenario Simulator</div>
        <div class="training-grid">
          ${scenarioCards}
        </div>

        <!-- Quick Stats -->
        ${state.trainingHistory.length > 0 ? `
        <div class="tm-section-label">YOUR STATS</div>
        <div class="tm-stats-row">
          <div class="tm-stat">
            <div class="tm-stat-val">${state.trainingHistory.length}</div>
            <div class="tm-stat-lbl">Sessions</div>
          </div>
          <div class="tm-stat">
            <div class="tm-stat-val">${state.trainingHistory.filter(h => h.outcome === 'win').length}</div>
            <div class="tm-stat-lbl">Wins</div>
          </div>
          <div class="tm-stat">
            <div class="tm-stat-val">${Math.round(state.trainingHistory.reduce((s, h) => s + (h.pct || 0), 0) / state.trainingHistory.length)}%</div>
            <div class="tm-stat-lbl">Avg Score</div>
          </div>
          <div class="tm-stat">
            <div class="tm-stat-val">${Math.round(state.trainingHistory.reduce((s, h) => s + (h.duration || 0), 0) / 60)} min</div>
            <div class="tm-stat-lbl">Total Time</div>
          </div>
        </div>` : ''}
      </div>`;
  }
  function renderScenarioNode() {
    const node = state.currentScenario.nodes[state.currentNodeId];
    if (!node) return '<div class="training-error">Node not found</div>';

    const progress = state.scenarioPath.length;

    return `
      <div class="scenario-view">
        <div class="sv-header">
          <button class="btn btn-ghost" data-st-action="backToMenu" style="font-size:11px;">← Exit</button>
          <div class="sv-title">${state.currentScenario.icon} ${state.currentScenario.title}</div>
          <div class="sv-progress">Step ${progress + 1}</div>
        </div>
        <div class="sv-prompt">
          <div class="sv-prompt-text">${node.prompt}</div>
        </div>
        <div class="sv-options-label">What do you say?</div>
        <div class="sv-options">
          ${node.options.map((opt, i) => `
            <div class="sv-option" data-st-action="chooseOption" data-st-id="${i}">
              <div class="sv-opt-letter">${String.fromCharCode(65 + i)}</div>
              <div class="sv-opt-text">${opt.text}</div>
            </div>
          `).join('')}
        </div>
      </div>`;
  }
  function renderFeedback() {
    const lastStep = state.scenarioPath[state.scenarioPath.length - 1];
    const node = state.currentScenario.nodes[state.currentNodeId];
    const opt = node.options[lastStep.optionIdx];
    const maxNodeScore = Math.max(...node.options.map(o => o.score));
    const wasOptimal = opt.score === maxNodeScore;
    const pctOfMax = Math.round((opt.score / maxNodeScore) * 100);

    // Show all options ranked for learning
    const ranked = [...node.options].sort((a, b) => b.score - a.score);

    return `
      <div class="scenario-view">
        <div class="sv-header">
          <button class="btn btn-ghost" data-st-action="backToMenu" style="font-size:11px;">← Exit</button>
          <div class="sv-title">${state.currentScenario.icon} ${state.currentScenario.title}</div>
          <div class="sv-progress">Feedback</div>
        </div>
        <div class="fb-card ${wasOptimal ? 'fb-optimal' : pctOfMax >= 50 ? 'fb-decent' : 'fb-poor'}">
          <div class="fb-score-row">
            <span class="fb-emoji">${wasOptimal ? '🎯' : pctOfMax >= 50 ? '🟡' : '❌'}</span>
            <span class="fb-score-label">${wasOptimal ? 'Optimal Choice' : pctOfMax >= 50 ? 'Decent — But There\'s a Better Move' : 'Weak Choice — Here\'s Why'}</span>
            <span class="fb-pts">+${opt.score} pts</span>
          </div>
          <div class="fb-text">${lastStep.feedback}</div>
          ${opt.tags ? `
          <div class="fb-tags">
            ${Object.entries(opt.tags).filter(([,v]) => v > 0).sort((a,b) => b[1] - a[1]).map(([tag, val]) => `
              <span class="fb-tag" style="background:${state.SKILL_TAGS[tag]?.color || '#666'}20;color:${state.SKILL_TAGS[tag]?.color || '#666'};border:1px solid ${state.SKILL_TAGS[tag]?.color || '#666'}30;">
                ${state.SKILL_TAGS[tag]?.icon || ''} ${state.SKILL_TAGS[tag]?.label || tag} +${val}
              </span>
            `).join('')}
          </div>` : ''}
        </div>

        ${!wasOptimal ? `
        <div class="fb-better">
          <div class="fb-better-label">💡 The stronger move:</div>
          <div class="fb-better-text">"${ranked[0].text.substring(0, 200)}${ranked[0].text.length > 200 ? '...' : ''}"</div>
        </div>` : ''}

        <button class="btn btn-orange" style="width:100%;padding:14px;font-size:15px;font-weight:700;margin-top:16px;" data-st-action="advance">
          Continue →
        </button>
      </div>`;
  }
  function renderScenarioResults() {
    const r = window._lastTrainingResult;
    if (!r) return '';
    const terminalStep = r.path.find(s => s.terminal);

    return `
      <div class="results-view">
        <div class="rv-header">
          <div class="rv-outcome rv-${r.outcome}">${r.outcome === 'win' ? '✅ INSPECTION EARNED' : r.outcome === 'partial' ? '🟡 PARTIAL WIN' : '❌ OPPORTUNITY LOST'}</div>
          <div class="rv-scenario">${r.scenario.icon} ${r.scenario.title}</div>
        </div>

        ${terminalStep ? `<div class="rv-terminal">${terminalStep.prompt}</div>` : ''}

        <div class="rv-score-card">
          <div class="rv-stars">${state.starsHTML(r.stars, 28)}</div>
          <div class="rv-score">${r.pct}%</div>
          <div class="rv-score-detail">${r.totalEarned} / ${r.totalPossible} points · ${r.path.filter(s => !s.terminal).length} decisions · ${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}</div>
        </div>

        <div class="rv-skills-label">SKILL BREAKDOWN</div>
        <div class="rv-skills">
          ${(() => {
            const maxVal = Math.max(0, ...Object.values(r.skillScores));
            return Object.entries(r.skillScores).filter(([,v]) => v > 0).sort((a,b) => b[1] - a[1]).map(([tag, val]) => {
            const pct = maxVal > 0 ? Math.round((val / maxVal) * 100) : 0;
            return `
              <div class="rv-skill-row">
                <div class="rv-skill-label">${state.SKILL_TAGS[tag]?.icon || ''} ${state.SKILL_TAGS[tag]?.label || tag}</div>
                <div class="rv-skill-bar"><div class="rv-skill-fill" style="width:${pct}%;background:${state.SKILL_TAGS[tag]?.color || '#666'};"></div></div>
                <div class="rv-skill-val">${val} pts</div>
              </div>`;
            }).join('');
          })()}
        </div>

        <div class="rv-path-label">YOUR PATH</div>
        <div class="rv-path">
          ${r.path.filter(s => !s.terminal).map((step, i) => {
            const maxForNode = state.currentScenario ? Math.max(...(state.currentScenario.nodes[step.nodeId]?.options || []).map(o => o.score)) : 30;
            const wasOpt = step.score === maxForNode;
            return `
              <div class="rv-step ${wasOpt ? 'rv-step-opt' : 'rv-step-sub'}">
                <div class="rv-step-num">${i + 1}</div>
                <div class="rv-step-body">
                  <div class="rv-step-choice">${wasOpt ? '🎯' : '🔸'} ${step.choiceText.substring(0, 120)}${step.choiceText.length > 120 ? '...' : ''}</div>
                  <div class="rv-step-score">+${step.score} pts</div>
                </div>
              </div>`;
          }).join('')}
        </div>

        <div class="rv-actions">
          <button class="btn btn-orange" data-st-action="startScenario" data-st-id="${r.scenario.id}" style="flex:1;padding:12px;font-weight:700;">🔄 Try Again</button>
          <button class="btn btn-ghost" data-st-action="backToMenu" style="flex:1;padding:12px;">← Back to Menu</button>
        </div>
      </div>`;
  }
  function renderRapidFire() {
    const objection = state.OBJECTIONS[state.rapidQueue[state.rapidIndex]];
    const progress = `${state.rapidIndex + 1} / ${state.OBJECTIONS.length}`;
    const elapsed = Math.round((Date.now() - state.rapidStartTime) / 1000);

    return `
      <div class="rapid-view">
        <div class="rapid-header">
          <button class="btn btn-ghost" data-st-action="backToMenu" style="font-size:11px;">← Exit</button>
          <div class="rapid-stats-bar">
            <span class="rs-item">⚡ ${progress}</span>
            <span class="rs-item">🎯 ${state.rapidCorrect}/${state.rapidIndex + (state.rapidAnswered ? 1 : 0)}</span>
            <span class="rs-item">🔥 ${state.rapidStreak}</span>
            <span class="rs-item">⏱ ${elapsed}s</span>
          </div>
        </div>

        <div class="rapid-card">
          <div class="rapid-context">${objection.context}</div>
          <div class="rapid-objection">${objection.objection}</div>
        </div>

        <div class="rapid-options">
          ${objection.options.map((opt, i) => {
            let optClass = 'rapid-opt';
            let extra = '';
            if (state.rapidAnswered) {
              if (opt.correct) optClass += ' rapid-opt-correct';
              else if (i === state.rapidSelectedIdx) optClass += ' rapid-opt-wrong';
              extra = `<div class="rapid-opt-explain">${opt.explanation}</div>`;
            }
            return `
              <div class="${optClass}" ${state.rapidAnswered ? "" : `data-st-action="rapidAnswer" data-st-id="${i}"`} ${state.rapidAnswered ? 'style="pointer-events:none;"' : ''}>
                <div class="rapid-opt-text">${opt.text}</div>
                <div class="rapid-opt-score">${state.rapidAnswered ? `${opt.score}/3` : ''}</div>
                ${state.rapidAnswered ? extra : ''}
              </div>`;
          }).join('')}
        </div>

        ${state.rapidAnswered ? `
          <button class="btn btn-orange" style="width:100%;padding:14px;font-size:15px;font-weight:700;margin-top:12px;" data-st-action="rapidNext">
            ${state.rapidIndex + 1 >= state.OBJECTIONS.length ? 'See Results →' : 'Next Objection →'}
          </button>` : ''}
      </div>`;
  }
  function renderRapidResults() {
    const r = window._lastTrainingResult;
    if (!r) return '';

    return `
      <div class="results-view">
        <div class="rv-header">
          <div class="rv-outcome rv-${r.pct >= 70 ? 'win' : r.pct >= 40 ? 'partial' : 'loss'}">⚡ OBJECTION OBLITERATOR — COMPLETE</div>
        </div>

        <div class="rv-score-card">
          <div class="rv-stars">${state.starsHTML(r.stars, 28)}</div>
          <div class="rv-score">${r.pct}%</div>
          <div class="rv-score-detail">${r.correct} / ${r.total} perfect answers · Best streak: ${r.bestStreak} 🔥 · ${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}</div>
        </div>

        <div class="rv-skills-label">SKILL BREAKDOWN</div>
        <div class="rv-skills">
          ${(() => {
            const maxVal = Math.max(0, ...Object.values(r.skillScores));
            return Object.entries(r.skillScores).filter(([,v]) => v > 0).sort((a,b) => b[1] - a[1]).map(([tag, val]) => {
            const pct = maxVal > 0 ? Math.round((val / maxVal) * 100) : 0;
            return `
              <div class="rv-skill-row">
                <div class="rv-skill-label">${state.SKILL_TAGS[tag]?.icon || ''} ${state.SKILL_TAGS[tag]?.label || tag}</div>
                <div class="rv-skill-bar"><div class="rv-skill-fill" style="width:${pct}%;background:${state.SKILL_TAGS[tag]?.color || '#666'};"></div></div>
                <div class="rv-skill-val">${val} pts</div>
              </div>`;
            }).join('');
          })()}
        </div>

        <div class="rv-actions">
          <button class="btn btn-orange" data-st-action="startRapidFire" style="flex:1;padding:12px;font-weight:700;">⚡ Try Again</button>
          <button class="btn btn-ghost" data-st-action="backToMenu" style="flex:1;padding:12px;">← Back to Menu</button>
        </div>
      </div>`;
  }
  function renderProfile() {
    const scenarioSessions = state.trainingHistory.filter(h => h.type === 'scenario');
    const rapidSessions = state.trainingHistory.filter(h => h.type === 'rapid');

    return `
      <div class="profile-view">
        <div class="pv-header">
          <button class="btn btn-ghost" data-st-action="backToMenu" style="font-size:11px;">← Back</button>
          <div class="pv-title">📊 Training Profile</div>
        </div>

        <div class="pv-stats-grid">
          <div class="pv-stat"><div class="pv-stat-val">${state.trainingHistory.length}</div><div class="pv-stat-lbl">Total Sessions</div></div>
          <div class="pv-stat"><div class="pv-stat-val">${scenarioSessions.filter(h => h.outcome === 'win').length}</div><div class="pv-stat-lbl">Scenarios Won</div></div>
          <div class="pv-stat"><div class="pv-stat-val">${state.trainingHistory.length > 0 ? Math.round(state.trainingHistory.reduce((s, h) => s + (h.pct || 0), 0) / state.trainingHistory.length) : 0}%</div><div class="pv-stat-lbl">Avg Score</div></div>
          <div class="pv-stat"><div class="pv-stat-val">${Math.round(state.trainingHistory.reduce((s, h) => s + (h.duration || 0), 0) / 60)}</div><div class="pv-stat-lbl">Minutes Trained</div></div>
        </div>

        <div class="pv-section-label">SKILL PROFILE</div>
        <div class="pv-skills">
          ${(() => {
            const maxAvg = Math.max(0, ...Object.keys(state.SKILL_TAGS).map(t => (state.skillProfile[t] || {}).avg || 0));
            return Object.entries(state.SKILL_TAGS).map(([tag, info]) => {
              const data = state.skillProfile[tag] || { avg: 0, count: 0 };
              const barWidth = maxAvg > 0 ? Math.round(data.avg / maxAvg * 100) : 0;
              return `
              <div class="pv-skill-row">
                <div class="pv-skill-info">
                  <span class="pv-skill-icon">${info.icon}</span>
                  <span class="pv-skill-name">${info.label}</span>
                  <span class="pv-skill-count">(${data.count} samples)</span>
                </div>
                <div class="pv-skill-bar"><div class="pv-skill-fill" style="width:${barWidth}%;background:${info.color};"></div></div>
                <div class="pv-skill-val">${data.avg} pts</div>
              </div>`;
            }).join('');
          })()}
        </div>

        <div class="pv-section-label">RECENT SESSIONS</div>
        <div class="pv-history">
          ${state.trainingHistory.length === 0 ? '<div class="pv-empty">No training sessions yet. Start a scenario or rapid-fire drill!</div>' : ''}
          ${state.trainingHistory.slice(0, 20).map(h => {
            const date = h.completedAt?.toDate ? h.completedAt.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
            const time = h.completedAt?.toDate ? h.completedAt.toDate().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
            return `
              <div class="pv-session">
                <div class="pv-session-icon">${h.type === 'rapid' ? '⚡' : (state.SCENARIOS.find(s => s.id === h.scenarioId)?.icon || '📋')}</div>
                <div class="pv-session-info">
                  <div class="pv-session-title">${h.type === 'rapid' ? 'Objection Obliterator' : (h.scenarioTitle || 'Scenario')}</div>
                  <div class="pv-session-meta">${date} ${time} · ${Math.floor((h.duration || 0) / 60)}:${String((h.duration || 0) % 60).padStart(2, '0')}</div>
                </div>
                <div class="pv-session-score">
                  ${state.starsHTML(h.stars || 0, 12)}
                  <div class="pv-session-pct">${h.pct || 0}%</div>
                </div>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  // ════════════════════════════════════════════════════════════
  // EXPORT TO STATE OBJECT
  // ════════════════════════════════════════════════════════════
  state.render = render;
  state.renderMenu = renderMenu;
  state.renderScenarioNode = renderScenarioNode;
  state.renderFeedback = renderFeedback;
  state.renderScenarioResults = renderScenarioResults;
  state.renderRapidFire = renderRapidFire;
  state.renderRapidResults = renderRapidResults;
  state.renderProfile = renderProfile;

  // ════════════════════════════════════════════════════════════
  // EVENT WIRING — CSP-safe click delegate (inline on* never
  // executes on /pro pages)
  // ════════════════════════════════════════════════════════════
  // Every control renders with data-st-action (+ data-st-id for scenario ids
  // and option indexes). The engine publishes the action functions on the
  // shared state object; 'advance' is the one attribute→method alias, and
  // option indexes arrive as strings so they're coerced to numbers. Bound
  // once at document scope so the handler survives every #trainingContent
  // innerHTML swap.
  const CLICK_ACTIONS = {
    startScenario:  { method: 'startScenario' },
    chooseOption:   { method: 'chooseOption', numeric: true },
    advance:        { method: 'advanceAfterFeedback' },
    rapidAnswer:    { method: 'rapidAnswer', numeric: true },
    rapidNext:      { method: 'rapidNext' },
    startRapidFire: { method: 'startRapidFire' },
    showProfile:    { method: 'showProfile' },
    backToMenu:     { method: 'backToMenu' }
  };

  if (!window._NBD_ST_DELEGATE_BOUND) {
    window._NBD_ST_DELEGATE_BOUND = true;
    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-st-action]');
      if (!t) return;
      const map = CLICK_ACTIONS[t.dataset.stAction];
      const fn = map && state[map.method];
      if (typeof fn !== 'function') {
        console.warn('[sales-training-ui] no dispatch for', t.dataset.stAction);
        return;
      }
      try {
        if (t.dataset.stId !== undefined) fn(map.numeric ? Number(t.dataset.stId) : t.dataset.stId);
        else fn();
      } catch (e) {
        console.error('[sales-training-ui] dispatch ' + t.dataset.stAction + ' failed:', e);
      }
    });
  }

})();
