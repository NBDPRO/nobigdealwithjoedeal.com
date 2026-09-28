/**
 * NBD Pro Theme Engine - Achievement Unlock System
 * Tracks user progress toward unlocking special achievement-locked themes
 * Reads from window._leads, window._user, and Firestore
 */

(function() {
  'use strict';

  // Achievement definitions
  const ACHIEVEMENTS = [
    {
      themeKey: 'gold-rush',
      name: 'Gold Rush',
      description: 'Close 10 deals',
      icon: '💰',
      check: function(stats) {
        return stats.wonDeals >= 10;
      },
      progress: function(stats) {
        return Math.min(stats.wonDeals / 10, 1);
      }
    },
    {
      themeKey: 'eternal-flame',
      name: 'Eternal Flame',
      description: '30-day login streak',
      icon: '🔥',
      check: function(stats) {
        return stats.loginStreak >= 30;
      },
      progress: function(stats) {
        return Math.min(stats.loginStreak / 30, 1);
      }
    },
    {
      themeKey: 'iron-door',
      name: 'Iron Door',
      description: 'Knock 500 doors',
      icon: '🚪',
      check: function(stats) {
        return stats.totalKnocks >= 500;
      },
      progress: function(stats) {
        return Math.min(stats.totalKnocks / 500, 1);
      }
    },
    {
      themeKey: 'diamond',
      name: 'Diamond',
      description: 'Generate $100K in revenue',
      icon: '💎',
      check: function(stats) {
        return stats.revenueGenerated >= 100000;
      },
      progress: function(stats) {
        return Math.min(stats.revenueGenerated / 100000, 1);
      }
    },
    {
      themeKey: 'completionist',
      name: 'Completionist',
      description: 'Use every major feature',
      icon: '⭐',
      check: function(stats) {
        const requiredFeatures = ['crm', 'estimates', 'd2d', 'photos', 'documents',
          'reports', 'calendar', 'email-drip', 'material-calc', 'supplier-pricing', 'insurance-claims'];
        return requiredFeatures.every(feat => stats.featureUsage[feat]);
      },
      progress: function(stats) {
        const requiredFeatures = ['crm', 'estimates', 'd2d', 'photos', 'documents',
          'reports', 'calendar', 'email-drip', 'material-calc', 'supplier-pricing', 'insurance-claims'];
        const used = requiredFeatures.filter(feat => stats.featureUsage[feat]).length;
        return Math.min(used / requiredFeatures.length, 1);
      }
    },
    {
      themeKey: 'night-owl',
      name: 'Night Owl',
      description: 'Log in after midnight 10 times',
      icon: '🦉',
      check: function(stats) {
        return stats.midnightLogins >= 10;
      },
      progress: function(stats) {
        return Math.min(stats.midnightLogins / 10, 1);
      }
    },
    {
      themeKey: 'road-warrior',
      name: 'Road Warrior',
      description: 'Complete 100 on-site inspections',
      icon: '🛣️',
      check: function(stats) {
        return stats.inspectionsCompleted >= 100;
      },
      progress: function(stats) {
        return Math.min(stats.inspectionsCompleted / 100, 1);
      }
    },
    {
      themeKey: 'legend',
      name: 'Legend',
      description: 'Unlock all other achievement themes',
      icon: '👑',
      check: function(stats) {
        // Check if all other 7 achievements are unlocked
        const otherKeys = ['gold-rush', 'eternal-flame', 'iron-door', 'diamond',
          'completionist', 'night-owl', 'road-warrior'];
        return otherKeys.every(key => window._themeUnlocks && window._themeUnlocks.has(key));
      },
      progress: function(stats) {
        const otherKeys = ['gold-rush', 'eternal-flame', 'iron-door', 'diamond',
          'completionist', 'night-owl', 'road-warrior'];
        const unlockedCount = otherKeys.filter(key =>
          window._themeUnlocks && window._themeUnlocks.has(key)
        ).length;
        return Math.min(unlockedCount / 7, 1);
      }
    },
    {
      themeKey: 'dragon-ball-super',
      name: 'Dragon Ball Super',
      description: 'Earn Dragon Ball Z theme first + 50 won deals',
      icon: '🐉',
      check: function(stats) {
        return stats.dragonBallZUsed && stats.wonDeals >= 50;
      },
      progress: function(stats) {
        if (!stats.dragonBallZUsed) return 0;
        return Math.min(stats.wonDeals / 50, 1);
      }
    },
    {
      themeKey: 'hologram',
      name: 'Hologram',
      description: 'Create 5 custom themes',
      icon: '✨',
      check: function(stats) {
        return stats.customThemesCount >= 5;
      },
      progress: function(stats) {
        return Math.min(stats.customThemesCount / 5, 1);
      }
    }
  ];

  // Module state
  let initialized = false;
  const statsCache = {};

  // Public API
  const ThemeAchievements = {
    /**
     * Initialize: Load unlocked achievements from Firestore
     */
    init: async function() {
      if (initialized) return;

      // Initialize window._themeUnlocks if needed
      if (!window._themeUnlocks) {
        window._themeUnlocks = new Set();
      }

      try {
        // Load from Firestore userSettings
        const uid = window._user?.uid;
        if (uid && window.db && window.getDoc && window.doc) {
          // QA 2026-06-21 #1: retry transient cold-boot offline (WebChannel not up yet).
          const snap = await (window.nbdRetryOffline || (f => f()))(() => window.getDoc(window.doc(window.db, 'userSettings', uid)));
          if (snap.exists() && snap.data().themeUnlocks) {
            snap.data().themeUnlocks.forEach(key => {
              window._themeUnlocks.add(key);
            });
          }
        }
      } catch (error) {
        console.warn('Failed to load theme unlocks from Firestore:', error);
      }

      initialized = true;
      this.checkAll();
    },

    /**
     * Gather stats and check all achievements
     */
    checkAll: async function() {
      const stats = await this._gatherStats();

      ACHIEVEMENTS.forEach(achievement => {
        const isUnlocked = window._themeUnlocks && window._themeUnlocks.has(achievement.themeKey);
        const meetsCondition = achievement.check(stats);

        // If newly unlocked
        if (!isUnlocked && meetsCondition) {
          this.unlock(achievement.themeKey);
        }
      });
    },

    /**
     * Unlock an achievement theme
     */
    unlock: function(achievementKey) {
      if (window._themeUnlocks && window._themeUnlocks.has(achievementKey)) {
        return; // Already unlocked
      }

      if (!window._themeUnlocks) {
        window._themeUnlocks = new Set();
      }

      window._themeUnlocks.add(achievementKey);

      // Save to Firestore
      const uid = window._user?.uid;
      if (uid && window.db && window.updateDoc && window.doc) {
        window.updateDoc(window.doc(window.db, 'userSettings', uid), {
          themeUnlocks: Array.from(window._themeUnlocks)
        }).catch(err => console.warn('Failed to save unlock:', err));
      }

      // Show unlock toast
      const achievement = ACHIEVEMENTS.find(a => a.themeKey === achievementKey);
      if (achievement) {
        this._showUnlockToast(achievement);
      }
    },

    /**
     * Get all achievements with current progress
     */
    getAll: async function() {
      const stats = await this._gatherStats();

      return ACHIEVEMENTS.map(achievement => ({
        ...achievement,
        unlocked: window._themeUnlocks && window._themeUnlocks.has(achievement.themeKey),
        currentProgress: achievement.progress(stats)
      }));
    },

    /**
     * Get progress for a specific achievement
     */
    getProgress: async function(key) {
      const stats = await this._gatherStats();
      const achievement = ACHIEVEMENTS.find(a => a.themeKey === key);

      if (!achievement) return null;

      const unlocked = window._themeUnlocks && window._themeUnlocks.has(key);
      const progress = achievement.progress(stats);

      // Estimate current/target based on achievement type
      let current = 0, target = 10;

      if (key === 'gold-rush') { current = stats.wonDeals; target = 10; }
      else if (key === 'eternal-flame') { current = stats.loginStreak; target = 30; }
      else if (key === 'iron-door') { current = stats.totalKnocks; target = 500; }
      else if (key === 'diamond') { current = Math.floor(stats.revenueGenerated / 1000); target = 100; }
      else if (key === 'completionist') {
        const used = ['crm', 'estimates', 'd2d', 'photos', 'documents', 'reports',
          'calendar', 'email-drip', 'material-calc', 'supplier-pricing', 'insurance-claims']
          .filter(f => stats.featureUsage[f]).length;
        current = used; target = 11;
      }
      else if (key === 'night-owl') { current = stats.midnightLogins; target = 10; }
      else if (key === 'road-warrior') { current = stats.inspectionsCompleted; target = 100; }
      else if (key === 'dragon-ball-super') { current = stats.wonDeals; target = 50; }
      else if (key === 'hologram') { current = stats.customThemesCount; target = 5; }
      else if (key === 'legend') {
        const otherKeys = ['gold-rush', 'eternal-flame', 'iron-door', 'diamond',
          'completionist', 'night-owl', 'road-warrior'];
        current = otherKeys.filter(k => window._themeUnlocks && window._themeUnlocks.has(k)).length;
        target = 7;
      }

      return { unlocked, progress, current, target };
    },

    /**
     * Render full achievement panel UI
     */
    renderAchievementPanel: async function(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;

      const achievements = await this.getAll();
      const unlockedCount = achievements.filter(a => a.unlocked).length;

      let html = `
        <div class="achievement-panel">
          <div class="achievement-header">
            <h2>Achievement Themes</h2>
            <p class="unlock-count">${unlockedCount} of ${ACHIEVEMENTS.length} Unlocked</p>
          </div>
          <div class="achievement-grid">
      `;

      achievements.forEach(achievement => {
        const progressPercent = Math.round(achievement.currentProgress * 100);
        const statusClass = achievement.unlocked ? 'unlocked' : 'locked';

        html += `
          <div class="achievement-card ${statusClass}">
            <div class="achievement-icon">${achievement.icon}</div>
            <h3>${achievement.name}</h3>
            <p class="achievement-desc">${achievement.description}</p>
            <div class="progress-container">
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${progressPercent}%"></div>
              </div>
              <span class="progress-text">${progressPercent}%</span>
            </div>
        `;

        if (achievement.unlocked) {
          html += `
            <div class="achievement-status">
              <span class="checkmark">✓</span>
              <button class="try-theme-btn" data-theme="${achievement.themeKey}">Try Theme</button>
            </div>
          `;
        } else {
          html += `<p class="achievement-locked">Locked</p>`;
        }

        html += `</div>`;
      });

      html += `</div></div>`;

      container.innerHTML = html;
      this._attachPanelListeners(container);
    },

    /**
     * Track feature usage
     */
    trackFeatureUsage: function(featureName) {
      const uid = window._user?.uid;
      if (!uid || !window.db) return;

      if (!statsCache.featureUsage) {
        statsCache.featureUsage = {};
      }
      statsCache.featureUsage[featureName] = true;

      if (window.updateDoc && window.doc) {
        window.updateDoc(window.doc(window.db, 'userSettings', uid), {
          [`featureUsage.${featureName}`]: true
        }).catch(err => console.warn('Failed to track feature usage:', err));
      }

      this.checkAll();
    },

    /**
     * Track midnight login
     */
    trackMidnightLogin: function() {
      const hour = new Date().getHours();
      if (hour < 5) { // Hours 0-4 are "midnight"
        const uid = window._user?.uid;
        if (!uid || !window.db) return;

        if (window.getDoc && window.doc && window.updateDoc) {
          window.getDoc(window.doc(window.db, 'userSettings', uid)).then(snap => {
            const current = (snap.data()?.midnightLogins || 0) + 1;
            window.updateDoc(window.doc(window.db, 'userSettings', uid), {
              midnightLogins: current,
              lastMidnightLogin: new Date()
            }).catch(err => console.warn('Failed to track midnight login:', err));

            statsCache.midnightLogins = current;
            this.checkAll();
          });
        }
      }
    },

    /**
     * Track login streak
     */
    trackLoginStreak: async function() {
      const uid = window._user?.uid;
      if (!uid || !window.db) return;

      const snap = await window.getDoc(window.doc(window.db, 'userSettings', uid));
      const userData = snap.data() || {};
      const lastLoginDate = userData.lastLoginDate;
      const today = new Date().toDateString();

      let streak = userData.loginStreak || 1;

      if (lastLoginDate) {
        const last = new Date(lastLoginDate);
        const now = new Date();
        const daysDiff = Math.floor((now - last) / (1000 * 60 * 60 * 24));

        if (daysDiff === 1) {
          streak += 1; // Continue streak
        } else if (daysDiff > 1) {
          streak = 1; // Reset streak
        }
        // If daysDiff === 0, same day, don't change streak
      }

      await window.updateDoc(window.doc(window.db, 'userSettings', uid), {
        loginStreak: streak,
        lastLoginDate: today
      }).catch(err => console.warn('Failed to track login streak:', err));

      statsCache.loginStreak = streak;
      this.checkAll();
    },

    // Private methods
    _gatherStats: async function() {
      if (statsCache.timestamp && Date.now() - statsCache.timestamp < 5000) {
        return statsCache; // Use cache if fresh
      }

      const stats = {
        wonDeals: 0,
        totalKnocks: 0,
        revenueGenerated: 0,
        loginStreak: 0,
        midnightLogins: 0,
        inspectionsCompleted: 0,
        featureUsage: {},
        customThemesCount: 0,
        dragonBallZUsed: false
      };

      // Count won deals from window._leads
      if (window._leads && Array.isArray(window._leads)) {
        // Semantic role (crm-stages, custom-pipeline aware): the literal
        // 'won' / 'completed' stage keys this used are not ones the CRM
        // writes, so no deal ever counted.
        const _role = (l) => l._stageRole || (typeof window.stageRole === 'function'
          ? (function () { try { return window.stageRole(l._stageKey || l.stage); } catch (_) { return null; } })() : null);
        const wonLeads = window._leads.filter(l => !l.deleted && _role(l) === 'won');
        stats.wonDeals = wonLeads.length;
        // "$100K in revenue" = money COLLECTED (Jo, 2026-09-28: revenue is
        // collected only) — all-time invoice payments, not won jobValue.
        const _R = window.NBDRevenue, _invs = _R ? _R.cached() : null;
        if (_R && !_invs) _R.loadInvoices();
        stats.revenueGenerated = _invs ? _R.collectedBetween(_invs, null, null).total : 0;

        stats.inspectionsCompleted = window._leads.filter(l => {
          const stages = ['inspected', 'estimate-sent', 'negotiating', 'won', 'completed'];
          return stages.includes(l.stage);
        }).length;
      }

      // Load from Firestore userSettings
      const uid = window._user?.uid;
      if (uid && window.db && window.getDoc && window.doc) {
        try {
          const settingsSnap = await window.getDoc(window.doc(window.db, 'userSettings', uid));
          if (settingsSnap.exists()) {
            const data = settingsSnap.data();
            stats.loginStreak = data.loginStreak || 0;
            stats.midnightLogins = data.midnightLogins || 0;
            stats.featureUsage = data.featureUsage || {};
            stats.customThemesCount = data.customThemesCount || 0;
            stats.dragonBallZUsed = data.appliedThemes?.includes('dragon-ball-z') || false;
          }

          // Count knocks from D2D collection
          if (window.collection && window.query && window.where && window.getDocs) {
            const knocksQ = window.query(window.collection(window.db, 'knocks'), window.where('userId', '==', uid));
            const knocksSnap = await (window.nbdRetryOffline || (f => f()))(() => window.getDocs(knocksQ));
            stats.totalKnocks = knocksSnap.size;
          }
        } catch (error) {
          console.warn('Failed to gather stats from Firestore:', error);
        }
      }

      stats.timestamp = Date.now();
      Object.assign(statsCache, stats);
      return stats;
    },

    _showUnlockToast: function(achievement) {
      // Create toast container
      const toast = document.createElement('div');
      toast.className = 'achievement-unlock-toast';
      toast.innerHTML = `
        <div class="toast-content">
          <div class="toast-icon">${achievement.icon}</div>
          <div class="toast-text">
            <div class="toast-label">THEME UNLOCKED!</div>
            <div class="toast-name">${achievement.name}</div>
          </div>
          <button class="toast-action-btn" data-theme="${achievement.themeKey}">Try it now!</button>
        </div>
      `;

      document.body.appendChild(toast);

      // Trigger animation
      setTimeout(() => toast.classList.add('show'), 10);

      // Attach listener
      toast.querySelector('.toast-action-btn').addEventListener('click', () => {
        if (window.ThemeEngine && typeof window.ThemeEngine.apply === 'function') {
          // Earned achievement → unlock then apply (engine method is apply(),
          // not applyTheme; unlock first so the plan-gate in apply() lets it through).
          if (typeof window.ThemeEngine.unlock === 'function') window.ThemeEngine.unlock(achievement.themeKey);
          window.ThemeEngine.apply(achievement.themeKey);
        }
        this._removeToast(toast);
      });

      // Auto-dismiss
      setTimeout(() => {
        this._removeToast(toast);
      }, 8000);
    },

    _removeToast: function(toast) {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    },

    _attachPanelListeners: function(container) {
      container.querySelectorAll('.try-theme-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const themeKey = e.target.dataset.theme;
          if (window.ThemeEngine && typeof window.ThemeEngine.apply === 'function') {
            // Engine method is apply(), not applyTheme. Unlock first so a
            // just-earned achievement theme clears the plan-gate in apply().
            if (typeof window.ThemeEngine.unlock === 'function') window.ThemeEngine.unlock(themeKey);
            window.ThemeEngine.apply(themeKey);
          }
        });
      });
    }
  };

  // Add CSS styles
  const addStyles = () => {
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      .achievement-panel {
        padding: 24px;
        background: var(--s1, #1a1a1a);
        border-radius: 12px;
      }

      .achievement-header {
        margin-bottom: 32px;
        text-align: center;
      }

      .achievement-header h2 {
        margin: 0 0 8px 0;
        font-size: 28px;
        color: var(--text-primary, #fff);
      }

      .unlock-count {
        margin: 0;
        font-size: 14px;
        color: #eab308;
        font-weight: 600;
      }

      .achievement-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 24px;
      }

      @media (max-width: 768px) {
        .achievement-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      @media (max-width: 480px) {
        .achievement-grid {
          grid-template-columns: 1fr;
        }
      }

      .achievement-card {
        padding: 20px;
        background: var(--s2, #2a2a2a);
        border: 2px solid #6b7280;
        border-radius: 10px;
        transition: all 0.3s ease;
      }

      .achievement-card.unlocked {
        border-color: #eab308;
        box-shadow: 0 0 15px rgba(234, 179, 8, 0.3);
      }

      .achievement-card:hover {
        transform: translateY(-2px);
      }

      .achievement-icon {
        font-size: 40px;
        margin-bottom: 12px;
      }

      .achievement-card h3 {
        margin: 12px 0 8px 0;
        font-size: 18px;
        color: var(--text-primary, #fff);
      }

      .achievement-desc {
        margin: 0 0 16px 0;
        font-size: 13px;
        color: #9ca3af;
      }

      .progress-container {
        margin-bottom: 16px;
      }

      .progress-bar {
        width: 100%;
        height: 8px;
        background: #4b5563;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 6px;
      }

      .progress-fill {
        height: 100%;
        background: #eab308;
        transition: width 0.3s ease;
      }

      .progress-text {
        font-size: 12px;
        color: #d1d5db;
      }

      .achievement-status {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .checkmark {
        font-size: 20px;
        color: #eab308;
      }

      .try-theme-btn {
        flex: 1;
        padding: 8px 12px;
        background: #eab308;
        color: #1a1a1a;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.2s;
      }

      .try-theme-btn:hover {
        background: #f5d547;
      }

      .achievement-locked {
        margin: 0;
        font-size: 13px;
        color: #9ca3af;
        text-align: center;
      }

      @keyframes slideDown {
        from {
          transform: translateY(-100%);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }

      @keyframes shimmer {
        0% { background-position: -1000px 0; }
        100% { background-position: 1000px 0; }
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.8; }
      }

      .achievement-unlock-toast {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: linear-gradient(90deg, #eab308 0%, #d4a614 50%, #eab308 100%);
        background-size: 200% 100%;
        animation: slideDown 0.5s ease, shimmer 2s infinite;
        z-index: 9999;
        transform: translateY(-100%);
        transition: transform 0.3s ease;
      }

      .achievement-unlock-toast.show {
        transform: translateY(0);
      }

      .toast-content {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        padding: 20px 32px;
        max-width: 1200px;
        margin: 0 auto;
      }

      .toast-icon {
        font-size: 48px;
        animation: pulse 1s infinite;
      }

      .toast-text {
        flex: 1;
      }

      .toast-label {
        font-size: 12px;
        font-weight: 700;
        color: rgba(0, 0, 0, 0.7);
        letter-spacing: 1px;
        margin-bottom: 4px;
      }

      .toast-name {
        font-size: 24px;
        font-weight: 700;
        color: rgba(0, 0, 0, 0.9);
      }

      .toast-action-btn {
        padding: 12px 24px;
        background: rgba(0, 0, 0, 0.2);
        color: rgba(0, 0, 0, 0.9);
        border: 2px solid rgba(0, 0, 0, 0.3);
        border-radius: 6px;
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
      }

      .toast-action-btn:hover {
        background: rgba(0, 0, 0, 0.3);
        transform: scale(1.05);
      }
    `;
    document.head.appendChild(styleEl);
  };

  // Initialize styles on first use
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addStyles);
  } else {
    addStyles();
  }

  // Expose to window
  window.ThemeAchievements = ThemeAchievements;
})();
