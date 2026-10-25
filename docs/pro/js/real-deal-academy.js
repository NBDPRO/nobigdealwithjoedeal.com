(function() {
  'use strict';

  // ===================================
  // REAL DEAL ACADEMY ENGINE
  // Main UI & Logic for NBD Pro Training System
  // ===================================

  const RealDealAcademy = {
    // ===== STATE & CONFIG =====
    _currentTab: 'overview',
    _currentCourse: null,
    _currentLesson: null,
    _currentBranch: null,
    _stylesInjected: false,
    _progressData: {
      completedNodes: new Set(),
      completedLessons: new Set(),
      quizScores: {} // { courseId_lessonId: { passed: bool, score: int, total: int } }
    },
    _userId: null,

    // ===== INITIALIZATION =====
    init() {
      this._userId = this._getCurrentUserId();
      this._injectStyles();
      this._loadProgress();
      this._stylesInjected = true;

      // If auth hasn't resolved yet, re-read progress once it does so a
      // real uid replaces the initial null and per-user Firestore sync
      // can take over. Prevents two different users on the same browser
      // from sharing the 'anonymous' bucket.
      if (!this._userId && window.auth && typeof window.auth.onAuthStateChanged === 'function') {
        const off = window.auth.onAuthStateChanged((user) => {
          if (user && user.uid && !this._userId) {
            this._userId = user.uid;
            this._loadProgress();
            // Auth resolved after mount — repaint with the real user's data.
            this._repaintCurrentTab();
          }
        });
        this._authUnsub = off;
      }
    },

    _getCurrentUserId() {
      // Try multiple sources to get current user ID. Return null when no
      // real user is known — callers MUST treat null as "do not persist
      // cross-session." Never return a shared literal like 'anonymous',
      // which silently bleeds progress between users on the same browser.
      if (window.currentUser && window.currentUser.uid) return window.currentUser.uid;
      if (window.auth && window.auth.currentUser && window.auth.currentUser.uid) return window.auth.currentUser.uid;
      const stored = localStorage.getItem('nbd_user_id');
      if (stored && stored !== 'anonymous') return stored;
      return null;
    },

    _loadProgress() {
      // No real user yet — keep whatever is in memory; do NOT read a
      // shared 'anonymous' bucket. Will re-run once auth resolves.
      if (!this._userId) return;
      const key = `rda_progress_${this._userId}`;

      // Try Firestore (v9 modular SDK via window globals) first
      if (window._db && window.doc && window.getDoc && window.auth && window.auth.currentUser) {
        try {
          const ref = window.doc(window._db, 'academy_progress', this._userId);
          window.getDoc(ref)
            .then(snap => {
              if (snap.exists()) {
                const data = snap.data() || {};
                this._progressData.completedNodes = new Set(data.completedNodes || []);
                this._progressData.completedLessons = new Set(data.completedLessons || []);
                this._progressData.quizScores = data.quizScores || {};
              }
              // Fresh device: progress arrives async — repaint the mounted
              // tab so stats/trees reflect it without a manual tab switch.
              this._repaintCurrentTab();
            })
            .catch(err => console.warn('Firestore load failed, using localStorage:', err));
        } catch (err) {
          console.warn('Firestore load threw, using localStorage:', err);
        }
      }

      // Fallback to localStorage
      const stored = localStorage.getItem(key);
      if (stored) {
        try {
          const data = JSON.parse(stored);
          this._progressData.completedNodes = new Set(data.completedNodes || []);
          this._progressData.completedLessons = new Set(data.completedLessons || []);
          this._progressData.quizScores = data.quizScores || {};
        } catch (e) {
          console.warn('Failed to parse progress data:', e);
        }
      }
    },

    _saveProgress() {
      // Do not persist under a shared bucket when no real uid is known —
      // progress stays in memory until auth resolves and we have a proper
      // per-user key.
      if (!this._userId) return;
      const key = `rda_progress_${this._userId}`;
      const data = {
        completedNodes: Array.from(this._progressData.completedNodes),
        completedLessons: Array.from(this._progressData.completedLessons),
        quizScores: this._progressData.quizScores
      };

      localStorage.setItem(key, JSON.stringify(data));

      // Save to Firestore (v9 modular SDK via window globals) if available
      if (window._db && window.doc && window.setDoc && window.auth && window.auth.currentUser) {
        try {
          const ref = window.doc(window._db, 'academy_progress', this._userId);
          window.setDoc(ref, data, { merge: true })
            .catch(err => console.warn('Firestore save failed:', err));
        } catch (err) {
          console.warn('Firestore save threw:', err);
        }
      }
    },

    _injectStyles() {
      if (this._stylesInjected) return;

      const styleTag = document.createElement('style');
      styleTag.id = 'rda-styles';
      styleTag.textContent = this._getStyles();
      document.head.appendChild(styleTag);
    },

    _getStyles() {
      return `
        :root {
          --rda-dark: #111418;
          --rda-dark2: #181C22;
          --rda-light: #E8EAF0;
          --rda-muted: #9CA3AF; /* was #6B7280: 3.5:1 on this dark surface as 12px text (UI sweep 2026-10-24) */
          --rda-border: rgba(255,255,255,.07);
          --rda-orange: #DD875F; /* the brand light orange: this surface stays dark on every theme, and #A14A22 read 3.1:1 on it as text (UI sweep 2026-10-24); fills use #BD5728 below */
          --rda-green: #10b981;
          --rda-red: #ef4444;
        }

        .rda-container {
          background: var(--rda-dark);
          color: var(--rda-light);
          font-family: 'Barlow', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          min-height: 100vh;
          padding: 20px;
        }

        .rda-header {
          text-align: center;
          margin-bottom: 40px;
          position: relative;
        }

        .rda-header-title {
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          font-size: 48px;
          font-weight: 900;
          letter-spacing: -1px;
          margin: 0 0 10px 0;
          line-height: 1;
        }

        .rda-header-title .rda-accent {
          color: var(--rda-orange);
        }

        .rda-header-tagline {
          font-size: 14px;
          color: var(--rda-muted);
          margin: 10px 0 0 0;
        }

        .rda-logo-badge {
          position: absolute;
          top: 0;
          right: 0;
          background: var(--rda-dark2);
          border: 1px solid var(--rda-border);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--rda-muted);
        }

        .rda-tabs {
          display: flex;
          gap: 5px;
          margin-bottom: 30px;
          border-bottom: 1px solid var(--rda-border);
          overflow-x: auto;
          padding-bottom: 0;
        }

        .rda-tab {
          padding: 12px 20px;
          background: transparent;
          border: none;
          color: var(--rda-muted);
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          white-space: nowrap;
          border-bottom: 2px solid transparent;
          transition: all 0.2s ease;
        }

        .rda-tab:hover {
          color: var(--rda-light);
        }

        .rda-tab.active {
          color: var(--rda-orange);
          border-bottom-color: var(--rda-orange);
        }

        .rda-content {
          animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .rda-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 40px;
        }

        .rda-stat-card {
          background: var(--rda-dark2);
          border: 1px solid var(--rda-border);
          border-radius: 10px;
          padding: 20px;
          text-align: center;
        }

        .rda-stat-label {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--rda-muted);
          margin-bottom: 10px;
        }

        .rda-stat-value {
          font-size: 32px;
          font-weight: 900;
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          color: var(--rda-light);
        }

        .rda-stat-subtitle {
          font-size: 12px;
          color: var(--rda-muted);
          margin-top: 8px;
        }

        .rda-section-title {
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          font-size: 24px;
          font-weight: 800;
          margin: 30px 0 20px 0;
          color: var(--rda-light);
        }

        .rda-phase-header {
          background: linear-gradient(135deg, rgba(161, 74, 34, 0.1), rgba(161, 74, 34, 0.05));
          border-left: 4px solid var(--rda-orange);
          padding: 15px 20px;
          margin: 30px 0 20px 0;
          border-radius: 4px;
        }

        .rda-phase-number {
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          font-size: 28px;
          font-weight: 900;
          color: var(--rda-orange);
          margin-right: 10px;
        }

        .rda-phase-title {
          font-size: 16px;
          font-weight: 700;
          color: var(--rda-light);
        }

        .rda-node-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }

        .rda-node-card {
          background: var(--rda-dark2);
          border: 1px solid var(--rda-border);
          border-radius: 10px;
          padding: 20px;
          cursor: pointer;
          transition: all 0.3s ease;
          position: relative;
        }

        .rda-node-card:hover {
          border-color: var(--rda-orange);
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(161, 74, 34, 0.15);
        }

        .rda-node-card.completed {
          opacity: 0.7;
        }

        .rda-node-card.completed::before {
          content: '✓';
          position: absolute;
          top: 10px;
          right: 10px;
          background: var(--rda-green);
          color: white;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          font-size: 18px;
        }

        .rda-node-icon {
          font-size: 32px;
          margin-bottom: 12px;
        }

        .rda-node-title {
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          font-size: 16px;
          font-weight: 800;
          margin-bottom: 4px;
          color: var(--rda-light);
        }

        .rda-node-subtitle {
          font-size: 12px;
          color: var(--rda-muted);
          margin-bottom: 12px;
          line-height: 1.4;
        }

        .rda-node-badges {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 12px;
        }

        .rda-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }

        .rda-badge-difficulty {
          background: rgba(107, 114, 128, 0.2);
          color: var(--rda-muted);
        }

        .rda-badge-time {
          background: rgba(16, 185, 129, 0.1);
          color: var(--rda-green);
        }

        .rda-course-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 24px;
          margin-bottom: 30px;
        }

        .rda-course-card {
          background: var(--rda-dark2);
          border: 1px solid var(--rda-border);
          border-radius: 10px;
          overflow: hidden;
          cursor: pointer;
          transition: all 0.3s ease;
          display: flex;
          flex-direction: column;
        }

        .rda-course-card:hover {
          border-color: var(--rda-orange);
          transform: translateY(-4px);
          box-shadow: 0 12px 32px rgba(161, 74, 34, 0.2);
        }

        .rda-course-card-header {
          background: linear-gradient(135deg, rgba(161, 74, 34, 0.2), rgba(161, 74, 34, 0.1));
          padding: 24px;
          text-align: center;
          position: relative;
        }

        .rda-course-icon {
          font-size: 48px;
          margin-bottom: 12px;
        }

        .rda-course-card-body {
          padding: 20px;
          flex: 1;
          display: flex;
          flex-direction: column;
        }

        .rda-course-title {
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          font-size: 18px;
          font-weight: 800;
          margin-bottom: 8px;
          color: var(--rda-light);
        }

        .rda-course-description {
          font-size: 13px;
          color: var(--rda-muted);
          line-height: 1.5;
          margin-bottom: 12px;
          flex: 1;
        }

        .rda-course-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11px;
          color: var(--rda-muted);
          margin-bottom: 12px;
          padding-top: 12px;
          border-top: 1px solid var(--rda-border);
        }

        .rda-progress-bar {
          width: 100%;
          height: 6px;
          background: var(--rda-dark);
          border-radius: 3px;
          overflow: hidden;
          margin-top: 12px;
        }

        .rda-progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #BD5728, #ff9800);
          transition: width 0.3s ease;
        }

        .rda-lock-icon {
          position: absolute;
          top: 12px;
          right: 12px;
          font-size: 24px;
          opacity: 0.6;
        }

        .rda-modal {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 20px;
          animation: fadeIn 0.2s ease;
        }

        .rda-modal-content {
          background: var(--rda-dark2);
          border: 1px solid var(--rda-border);
          border-radius: 10px;
          max-width: 700px;
          width: 100%;
          max-height: 80vh;
          overflow-y: auto;
          padding: 30px;
        }

        .rda-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 20px;
        }

        .rda-modal-title {
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          font-size: 28px;
          font-weight: 900;
          color: var(--rda-light);
        }

        .rda-close-btn {
          background: transparent;
          border: none;
          color: var(--rda-muted);
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .rda-close-btn:hover {
          color: var(--rda-light);
        }

        .rda-node-detail {
          margin: 20px 0;
        }

        .rda-node-detail-section {
          margin-bottom: 24px;
        }

        .rda-node-detail-title {
          font-weight: 700;
          color: var(--rda-orange);
          margin-bottom: 12px;
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .rda-checklist {
          background: var(--rda-dark);
          border-radius: 6px;
          padding: 12px;
        }

        .rda-checklist-item {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 8px;
          cursor: pointer;
        }

        .rda-checklist-checkbox {
          flex-shrink: 0;
          width: 18px;
          height: 18px;
          margin-top: 2px;
          accent-color: var(--rda-orange);
        }

        .rda-checklist-label {
          font-size: 13px;
          line-height: 1.4;
          color: var(--rda-light);
        }

        .rda-checklist-item input:checked + .rda-checklist-label {
          color: var(--rda-muted);
          text-decoration: line-through;
        }

        .rda-collapsible {
          margin-bottom: 12px;
        }

        .rda-collapsible-header {
          background: var(--rda-dark);
          border: 1px solid var(--rda-border);
          border-radius: 6px;
          padding: 12px 16px;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: 600;
          font-size: 14px;
          color: var(--rda-light);
          transition: all 0.2s ease;
        }

        .rda-collapsible-header:hover {
          background: rgba(161,74,34,0.1);
        }

        .rda-collapsible-arrow {
          font-size: 12px;
          transition: transform 0.2s ease;
        }

        .rda-collapsible-header.open .rda-collapsible-arrow {
          transform: rotate(180deg);
        }

        .rda-collapsible-body {
          display: none;
          background: var(--rda-dark);
          border: 1px solid var(--rda-border);
          border-top: none;
          border-radius: 0 0 6px 6px;
          padding: 16px;
        }

        .rda-collapsible-body.open {
          display: block;
        }

        .rda-button {
          display: inline-block;
          padding: 12px 24px;
          background: var(--orange, #BD5728);
          color: white;
          border: none;
          border-radius: 6px;
          font-weight: 700;
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          cursor: pointer;
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          transition: all 0.3s ease;
        }

        .rda-button:hover {
          background: #e0421a;
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(161, 74, 34, 0.4);
        }

        .rda-button-secondary {
          background: transparent;
          border: 1px solid var(--rda-orange);
          color: var(--rda-orange);
        }

        .rda-button-secondary:hover {
          background: rgba(161, 74, 34, 0.1);
        }

        .rda-button-small {
          padding: 8px 16px;
          font-size: 12px;
        }

        .rda-nav-buttons {
          display: flex;
          gap: 12px;
          justify-content: space-between;
          margin-top: 20px;
        }

        .rda-button-group {
          display: flex;
          gap: 12px;
        }

        .rda-quiz {
          background: var(--rda-dark);
          border: 1px solid var(--rda-border);
          border-radius: 8px;
          padding: 20px;
          margin: 20px 0;
        }

        .rda-quiz-question {
          margin-bottom: 20px;
        }

        .rda-quiz-question:last-child {
          margin-bottom: 0;
        }

        .rda-quiz-q {
          font-weight: 700;
          margin-bottom: 12px;
          color: var(--rda-light);
        }

        .rda-quiz-options {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .rda-quiz-option {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px;
          background: transparent;
          border: 1px solid var(--rda-border);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .rda-quiz-option:hover {
          border-color: var(--rda-orange);
          background: rgba(161,74,34,0.05);
        }

        .rda-quiz-option input[type="radio"] {
          accent-color: var(--rda-orange);
        }

        .rda-quiz-option label {
          flex: 1;
          cursor: pointer;
          font-size: 14px;
          color: var(--rda-light);
        }

        .rda-quiz-result {
          margin: 20px 0;
          padding: 16px;
          border-radius: 8px;
          border-left: 4px solid;
        }

        .rda-quiz-result.passed {
          background: rgba(16, 185, 129, 0.1);
          border-color: var(--rda-green);
          color: var(--rda-green);
        }

        .rda-quiz-result.failed {
          background: rgba(239, 68, 68, 0.1);
          border-color: var(--rda-red);
          color: var(--rda-red);
        }

        .rda-quiz-result-title {
          font-weight: 700;
          margin-bottom: 4px;
        }

        .rda-quiz-feedback {
          font-size: 13px;
          margin-top: 12px;
          padding: 12px;
          background: rgba(0,0,0,0.2);
          border-radius: 4px;
        }

        .rda-question-result {
          margin: 16px 0;
          padding: 12px;
          border-radius: 6px;
          border-left: 3px solid;
          font-size: 13px;
        }

        .rda-question-result.correct {
          background: rgba(16, 185, 129, 0.1);
          border-color: var(--rda-green);
          color: var(--rda-green);
        }

        .rda-question-result.incorrect {
          background: rgba(239, 68, 68, 0.1);
          border-color: var(--rda-red);
          color: var(--rda-red);
        }

        .rda-lesson-header {
          background: linear-gradient(135deg, rgba(161, 74, 34, 0.15), rgba(161, 74, 34, 0.05));
          padding: 24px;
          border-radius: 8px;
          margin-bottom: 24px;
        }

        .rda-lesson-title {
          font-family: 'Barlow Condensed', 'Barlow', sans-serif;
          font-size: 32px;
          font-weight: 900;
          color: var(--rda-light);
          margin: 0;
        }

        .rda-lesson-content {
          background: var(--rda-dark);
          border: 1px solid var(--rda-border);
          border-radius: 8px;
          padding: 20px;
          line-height: 1.7;
          margin-bottom: 24px;
        }

        .rda-lesson-content h3,
        .rda-lesson-content p {
          margin: 12px 0;
        }

        .rda-lesson-content strong {
          color: var(--rda-orange);
        }

        .rda-module-accordion {
          margin-bottom: 12px;
        }

        .rda-list-item {
          padding: 12px 0;
          border-bottom: 1px solid var(--rda-border);
        }

        .rda-list-item:last-child {
          border-bottom: none;
        }

        .rda-assignment-card {
          background: var(--rda-dark2);
          border: 1px solid var(--rda-border);
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .rda-assignment-info {
          flex: 1;
        }

        .rda-assignment-title {
          font-weight: 700;
          color: var(--rda-light);
          margin-bottom: 4px;
        }

        .rda-assignment-meta {
          font-size: 12px;
          color: var(--rda-muted);
        }

        .rda-empty-state {
          text-align: center;
          padding: 60px 20px;
          color: var(--rda-muted);
        }

        .rda-empty-icon {
          font-size: 48px;
          margin-bottom: 16px;
        }

        .rda-empty-title {
          font-size: 18px;
          font-weight: 700;
          margin-bottom: 8px;
          color: var(--rda-light);
        }

        .rda-empty-text {
          font-size: 14px;
          line-height: 1.6;
        }

        .rda-back-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 20px;
          color: var(--rda-orange);
          background: transparent;
          border: none;
          cursor: pointer;
          font-weight: 600;
          font-size: 14px;
        }

        .rda-back-btn:hover {
          color: #ff9800;
        }

        .rda-activity-item {
          padding: 12px;
          background: var(--rda-dark2);
          border: 1px solid var(--rda-border);
          border-radius: 6px;
          margin-bottom: 8px;
          font-size: 13px;
        }

        .rda-activity-title {
          font-weight: 700;
          color: var(--rda-light);
        }

        .rda-activity-time {
          color: var(--rda-muted);
          font-size: 11px;
          margin-top: 4px;
        }

        @media (max-width: 768px) {
          .rda-header-title {
            font-size: 32px;
          }

          .rda-stats {
            grid-template-columns: 1fr;
          }

          .rda-node-grid,
          .rda-course-grid {
            grid-template-columns: 1fr;
          }

          .rda-modal-content {
            max-height: 90vh;
          }

          .rda-tabs {
            gap: 2px;
            -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent 100%);
            mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent 100%);
          }

          .rda-tab {
            padding: 10px 12px;
            font-size: 11px;
          }

          .rda-logo-badge {
            position: static;
            margin-top: 10px;
          }
        }
      `;
    },

    // ===== MAIN ENTRY POINT =====
    renderAcademy(containerId) {
      const container = document.getElementById(containerId);
      if (!container) {
        console.error('Container not found:', containerId);
        return;
      }

      if (!this._stylesInjected) {
        this._injectStyles();
        this._stylesInjected = true;
      }

      this._container = container;
      container.innerHTML = this._buildAcademyUI();
      this._attachEventListeners(container);
      this._renderTab('overview', container);
    },

    // Re-render the currently mounted tab after a background progress load
    // mutates _progressData. Idempotent: the existing #rda-main-content /
    // .rda-container DOM is reusable. No-op when the academy isn't mounted.
    _repaintCurrentTab() {
      if (!this._container) return;
      this._renderTab(this._currentTab, this._container.querySelector('#rda-main-content') || this._container);
    },

    _buildAcademyUI() {
      return `
        <div class="rda-container">
          <div class="rda-header">
            <h1 class="rda-header-title">
              <span class="rda-accent">REAL DEAL</span> ACADEMY
            </h1>
            <p class="rda-header-tagline">Real training. Real results. Real Deal.</p>
            <div class="rda-logo-badge">NBD Pro</div>
          </div>

          <div class="rda-tabs" role="tablist">
            <button class="rda-tab active" data-tab="overview" role="tab">Overview</button>
            <button class="rda-tab" data-tab="insurance" role="tab">Insurance Process</button>
            <button class="rda-tab" data-tab="retail" role="tab">Retail Process</button>
            <button class="rda-tab" data-tab="courses" role="tab">Courses</button>
            <button class="rda-tab" data-tab="lab" role="tab">Local Authority Blueprint</button>
            <button class="rda-tab" data-tab="assignments" role="tab">My Assignments</button>
            <button class="rda-tab" data-tab="admin" id="rda-admin-tab" style="display:none;" role="tab">Admin</button>
          </div>

          <div class="rda-content" id="rda-main-content">
            <!-- Dynamic content here -->
          </div>
        </div>
      `;
    },

    _attachEventListeners(container) {
      // Tab clicks
      container.querySelectorAll('.rda-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const tabName = e.target.dataset.tab;
          this._switchTab(tabName, container);
        });
      });

      // Show admin tab if user is admin
      if (this._isAdmin()) {
        document.getElementById('rda-admin-tab').style.display = 'block';
      }
    },

    _switchTab(tabName, container) {
      this._currentTab = tabName;

      // Update tab buttons
      container.querySelectorAll('.rda-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
      });

      // Render new tab
      this._renderTab(tabName, container);
    },

    _renderTab(tabName, container) {
      // Accept either the outer container (resolve #rda-main-content) or the
      // content area itself (passed directly by background repaints).
      const contentArea = (container.id === 'rda-main-content')
        ? container
        : (container.querySelector('#rda-main-content') || container);

      switch (tabName) {
        case 'overview':
          this.renderOverview(contentArea);
          break;
        case 'insurance':
          this.renderProcessTree(contentArea, 'insurance');
          break;
        case 'retail':
          this.renderProcessTree(contentArea, 'retail');
          break;
        case 'courses':
          this.renderCourseList(contentArea);
          break;
        case 'lab':
          this.renderLocalAuthorityBlueprint(contentArea);
          break;
        case 'assignments':
          this.renderAssignments(contentArea);
          break;
        case 'admin':
          if (window.RealDealAdmin) {
            window.RealDealAdmin.renderAdminPanel(contentArea);
          }
          break;
      }
    },

    // ===== TAB: LOCAL AUTHORITY BLUEPRINT =====
    // Bridges to the window.LocalAuthorityBlueprint module
    // which lives in real-deal-academy-lab.js
    renderLocalAuthorityBlueprint(container) {
      if (!container) return;
      if (window.LocalAuthorityBlueprint && typeof window.LocalAuthorityBlueprint.renderInto === 'function') {
        window.LocalAuthorityBlueprint.renderInto(container);
        return;
      }
      container.innerHTML = `
        <div style="text-align:center;padding:60px 20px;">
          <h2 style="font-family:'Barlow Condensed',sans-serif;font-size:28px;
                     color:var(--orange,#BD5728);letter-spacing:.06em;text-transform:uppercase;
                     margin-bottom:12px;">Local Authority Blueprint</h2>
          <p style="color:#888;font-size:14px;margin-bottom:20px;">
            The 12-chapter SEO and local authority masterclass is loading...
          </p>
          <p style="color:#666;font-size:11px;">
            If this message persists, the Local Authority module may not have loaded.
            Check the browser console for errors.
          </p>
        </div>
      `;
    },

    // ===== TAB: OVERVIEW =====
    renderOverview(container) {
      const stats = this.getCompletionStats();
      const activities = this._getRecentActivity();

      let html = '<div class="rda-stats">';

      html += `
        <div class="rda-stat-card">
          <div class="rda-stat-label">Process Nodes</div>
          <div class="rda-stat-value">${stats.nodesComplete}/${stats.totalNodes}</div>
          <div class="rda-stat-subtitle">Completed</div>
        </div>
        <div class="rda-stat-card">
          <div class="rda-stat-label">Lessons</div>
          <div class="rda-stat-value">${stats.lessonsComplete}/${stats.totalLessons}</div>
          <div class="rda-stat-subtitle">Completed</div>
        </div>
        <div class="rda-stat-card">
          <div class="rda-stat-label">Quizzes Passed</div>
          <div class="rda-stat-value">${stats.quizzesPassed}/${stats.totalQuizzes}</div>
          <div class="rda-stat-subtitle">Completed</div>
        </div>
        <div class="rda-stat-card">
          <div class="rda-stat-label">Average Score</div>
          <div class="rda-stat-value">${stats.avgScore || 0}%</div>
          <div class="rda-stat-subtitle">Quiz Performance</div>
        </div>
      `;

      html += '</div>';

      // Recent Activity
      html += '<h2 class="rda-section-title">Recent Activity</h2>';
      if (activities.length > 0) {
        html += '<div>';
        activities.forEach(activity => {
          html += `
            <div class="rda-activity-item">
              <div class="rda-activity-title">${activity.title}</div>
              <div class="rda-activity-time">${activity.time}</div>
            </div>
          `;
        });
        html += '</div>';
      } else {
        html += `
          <div class="rda-empty-state">
            <div class="rda-empty-icon">📚</div>
            <div class="rda-empty-title">No Activity Yet</div>
            <div class="rda-empty-text">Start learning by picking a course or process to explore.</div>
          </div>
        `;
      }

      // Assigned Items (placeholder for now)
      html += '<h2 class="rda-section-title">Assigned Items</h2>';
      html += `
        <div class="rda-empty-state" style="padding: 40px 20px;">
          <div class="rda-empty-text">No assignments at this time.</div>
        </div>
      `;

      container.innerHTML = html;
    },

    _escapeHtml(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    _getRecentActivity() {
      // Build from real quiz attempts. Each quizScores entry carries a
      // .timestamp (ISO, written in submitQuiz) and .passed. Entries with
      // no timestamp predate that field — skip them.
      const scores = this._progressData.quizScores || {};
      return Object.entries(scores)
        .filter(([, result]) => result && result.timestamp)
        .map(([key, result]) => {
          const verb = result.passed ? 'Passed quiz' : 'Attempted quiz';
          return {
            timestamp: result.timestamp,
            title: this._escapeHtml(`${verb}: ${key}`),
            time: this._escapeHtml(new Date(result.timestamp).toLocaleString())
          };
        })
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
        .slice(0, 5);
    },

    // ===== TAB: PROCESS TREE =====
    renderProcessTree(container, branch) {
      const treeData = branch === 'insurance'
        ? window._academyInsuranceTree
        : window._academyRetailTree;

      if (!treeData || treeData.length === 0) {
        container.innerHTML = `
          <div class="rda-empty-state">
            <div class="rda-empty-icon">📋</div>
            <div class="rda-empty-title">No Process Available</div>
            <div class="rda-empty-text">This process tree is still being built.</div>
          </div>
        `;
        return;
      }

      let html = '';
      const branchTitle = branch === 'insurance' ? 'Insurance Restoration' : 'Retail Roofing';
      html += `<h2 class="rda-section-title">${branchTitle} Process</h2>`;

      // Group by phase
      const phaseMap = {};
      treeData.forEach(node => {
        const phase = node.phase || node.phaseLabel || 'Unknown';
        if (!phaseMap[phase]) {
          phaseMap[phase] = [];
        }
        phaseMap[phase].push(node);
      });

      // Render phases in order
      Object.keys(phaseMap).forEach(phase => {
        const nodes = phaseMap[phase];
        if (nodes.length === 0) return;

        // Group key (phase) stays the stable slug; render the human label.
        // Insurance has phaseLabel; retail uses phaseTitle + numeric phase.
        const phaseLabel = nodes[0].phaseLabel || nodes[0].phaseTitle || phase;
        const phaseNum = nodes[0].phaseNumber || nodes[0].phase || '';
        html += `
          <div class="rda-phase-header">
            <span class="rda-phase-number">${phaseNum}</span>
            <span class="rda-phase-title">${phaseLabel}</span>
          </div>
        `;

        html += '<div class="rda-node-grid">';
        nodes.forEach(node => {
          const isCompleted = this._progressData.completedNodes.has(node.id);
          html += this._buildNodeCard(node, isCompleted);
        });
        html += '</div>';
      });

      container.innerHTML = html;
      this._attachNodeCardListeners(container, branch);
    },

    _buildNodeCard(node, isCompleted) {
      const completedClass = isCompleted ? 'completed' : '';
      return `
        <div class="rda-node-card ${completedClass}" data-node-id="${node.id}">
          <div class="rda-node-icon">${node.icon || '📌'}</div>
          <div class="rda-node-title">${node.title}</div>
          <div class="rda-node-subtitle">${node.subtitle || ''}</div>
          <div class="rda-node-badges">
            <span class="rda-badge rda-badge-difficulty">${node.difficulty || 'beginner'}</span>
            <span class="rda-badge rda-badge-time">${node.estimatedTime || '30 min'}</span>
          </div>
        </div>
      `;
    },

    _attachNodeCardListeners(container, branch) {
      container.querySelectorAll('.rda-node-card').forEach(card => {
        card.addEventListener('click', () => {
          const nodeId = card.dataset.nodeId;
          const treeData = branch === 'insurance'
            ? window._academyInsuranceTree
            : window._academyRetailTree;
          const node = treeData.find(n => n.id === nodeId);
          if (node) {
            this._showNodeDetail(node, branch);
          }
        });
      });
    },

    _showNodeDetail(node, branch) {
      const modal = document.createElement('div');
      modal.className = 'rda-modal';
      modal.innerHTML = `
        <div class="rda-modal-content">
          <div class="rda-modal-header">
            <h2 class="rda-modal-title">${node.title}</h2>
            <button class="rda-close-btn">&times;</button>
          </div>

          <div class="rda-node-detail">
            <p style="color: var(--rda-muted); font-size: 14px; margin-bottom: 20px;">${node.subtitle}</p>

            ${node.content ? `<div class="rda-node-detail-section">${node.content}</div>` : ''}

            ${node.checklist ? `
              <div class="rda-node-detail-section">
                <div class="rda-node-detail-title">Checklist</div>
                <div class="rda-checklist">
                  ${node.checklist.map((item, i) => `
                    <div class="rda-checklist-item">
                      <input type="checkbox" id="check-${i}" class="rda-checklist-checkbox">
                      <label for="check-${i}" class="rda-checklist-label">${item}</label>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            ${node.proTips ? `
              <div class="rda-node-detail-section">
                <div class="rda-collapsible">
                  <div class="rda-collapsible-header">
                    💡 Pro Tips
                    <span class="rda-collapsible-arrow">▼</span>
                  </div>
                  <div class="rda-collapsible-body">
                    ${node.proTips.map(tip => `<p style="margin: 8px 0; font-size: 13px;">• ${tip}</p>`).join('')}
                  </div>
                </div>
              </div>
            ` : ''}

            ${node.commonMistakes ? `
              <div class="rda-node-detail-section">
                <div class="rda-collapsible">
                  <div class="rda-collapsible-header">
                    ⚠️ Common Mistakes
                    <span class="rda-collapsible-arrow">▼</span>
                  </div>
                  <div class="rda-collapsible-body">
                    ${node.commonMistakes.map(mistake => `<p style="margin: 8px 0; font-size: 13px;">• ${mistake}</p>`).join('')}
                  </div>
                </div>
              </div>
            ` : ''}

            <div class="rda-node-detail-section">
              <button class="rda-button" data-action="mark-complete" data-node-id="${node.id}">
                Mark Complete
              </button>
            </div>

            ${(node.isFork && node.forkOptions && node.forkOptions.length) ? `
              <div class="rda-node-detail-section">
                <div class="rda-node-detail-title">${node.forkLabel || 'Choose a path'}</div>
                <div class="rda-fork-options">
                  ${node.forkOptions.map((opt, fi) => `
                    <button class="rda-button rda-button-secondary" data-action="fork-option" data-fork-index="${fi}">
                      ${opt.label}
                    </button>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            <div class="rda-nav-buttons">
              <button class="rda-button rda-button-secondary" data-action="prev-node">
                ← Previous
              </button>
              <button class="rda-button rda-button-secondary" data-action="next-node">
                Next →
              </button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close modal
      modal.querySelector('.rda-close-btn').addEventListener('click', () => {
        modal.remove();
      });

      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });

      // Collapsibles
      modal.querySelectorAll('.rda-collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
          const isOpen = header.classList.toggle('open');
          header.nextElementSibling.classList.toggle('open', isOpen);
        });
      });

      // Mark complete button
      modal.querySelector('[data-action="mark-complete"]').addEventListener('click', () => {
        this.markNodeComplete(node.id);
        // Repaint the active process tree so the node card greens out
        // immediately instead of staying stale until a tab switch.
        const c = document.getElementById('academyContainer')?.querySelector('#rda-main-content');
        if (c) this.renderProcessTree(c, branch);
        modal.remove();
      });

      // Navigation
      const treeData = branch === 'insurance'
        ? window._academyInsuranceTree
        : window._academyRetailTree;

      // id -> node lookup so authored prevNodes/nextNodes/forkOptions can be
      // resolved by id instead of relying purely on array order.
      const nodeMap = new Map(treeData.map(n => [n.id, n]));
      const nodeIndex = treeData.findIndex(n => n.id === node.id);

      // Fork branch buttons — jump to the chosen authored path.
      modal.querySelectorAll('[data-action="fork-option"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const fi = parseInt(btn.dataset.forkIndex, 10);
          const opt = node.forkOptions && node.forkOptions[fi];
          const target = opt && nodeMap.get(opt.nodeId);
          if (target) {
            modal.remove();
            this._showNodeDetail(target, branch);
          }
        });
      });

      // Resolve authored neighbors first; fall back to array-index neighbors
      // when prevNodes/nextNodes are empty/absent so the linear path holds.
      const prevNode = (node.prevNodes && node.prevNodes.length && nodeMap.get(node.prevNodes[0]))
        || (nodeIndex > 0 ? treeData[nodeIndex - 1] : null);
      const nextNode = (node.nextNodes && node.nextNodes.length && nodeMap.get(node.nextNodes[0]))
        || (nodeIndex >= 0 && nodeIndex < treeData.length - 1 ? treeData[nodeIndex + 1] : null);

      if (!prevNode) {
        modal.querySelector('[data-action="prev-node"]').disabled = true;
        modal.querySelector('[data-action="prev-node"]').style.opacity = '0.5';
      } else {
        modal.querySelector('[data-action="prev-node"]').addEventListener('click', () => {
          modal.remove();
          this._showNodeDetail(prevNode, branch);
        });
      }

      if (!nextNode) {
        modal.querySelector('[data-action="next-node"]').disabled = true;
        modal.querySelector('[data-action="next-node"]').style.opacity = '0.5';
      } else {
        modal.querySelector('[data-action="next-node"]').addEventListener('click', () => {
          modal.remove();
          this._showNodeDetail(nextNode, branch);
        });
      }
    },

    // ===== TAB: COURSES =====
    renderCourseList(container) {
      const courses = window._academyCourses || [];

      if (!courses || courses.length === 0) {
        container.innerHTML = `
          <div class="rda-empty-state">
            <div class="rda-empty-icon">📚</div>
            <div class="rda-empty-title">No Courses Available</div>
            <div class="rda-empty-text">Courses are being prepared. Check back soon.</div>
          </div>
        `;
        return;
      }

      let html = '<h2 class="rda-section-title">Course Catalog</h2>';
      html += '<div class="rda-course-grid">';

      courses.forEach(course => {
        const progress = this._getCourseProgress(course.id);
        const progressPercent = progress.total > 0
          ? Math.round((progress.completed / progress.total) * 100)
          : 0;
        const isLocked = course.tier && course.tier !== 'foundation' && !this._isTierUnlocked(course.tier);
        const lockIcon = isLocked ? '<div class="rda-lock-icon">🔒</div>' : '';

        html += `
          <div class="rda-course-card" data-course-id="${course.id}" ${isLocked ? 'style="opacity:0.6;cursor:not-allowed"' : ''}>
            <div class="rda-course-card-header" style="position:relative;">
              <div class="rda-course-icon">${course.icon || '📖'}</div>
              ${lockIcon}
            </div>
            <div class="rda-course-card-body">
              <div class="rda-course-title">${course.title}</div>
              <div class="rda-course-description">${course.description}</div>
              <div class="rda-course-meta">
                <span>${course.difficulty || 'beginner'}</span>
                <span>${course.estimatedHours || '?'} hours</span>
              </div>
              <div class="rda-progress-bar">
                <div class="rda-progress-fill" style="width: ${progressPercent}%"></div>
              </div>
              <div style="font-size: 11px; color: var(--rda-muted); margin-top: 8px;">
                ${progressPercent}% complete
              </div>
            </div>
          </div>
        `;
      });

      html += '</div>';
      container.innerHTML = html;

      container.querySelectorAll('.rda-course-card').forEach(card => {
        if (!card.style.opacity) {
          card.addEventListener('click', () => {
            const courseId = card.dataset.courseId;
            this._switchToCourseView(courseId, container);
          });
        }
      });
    },

    _getCourseProgress(courseId) {
      const course = (window._academyCourses || []).find(c => c.id === courseId);
      if (!course) return { completed: 0, total: 0 };

      let total = 0;
      let completed = 0;

      if (course.modules) {
        course.modules.forEach(mod => {
          if (mod.lessons) {
            mod.lessons.forEach(lesson => {
              total++;
              if (this._progressData.completedLessons.has(`${courseId}_${lesson.id}`)) {
                completed++;
              }
            });
          }
        });
      }

      return { completed, total };
    },

    _isTierUnlocked(tier) {
      // Delegate to NBDAuth when available; falls back to the old
      // foundation-only behaviour if the auth module hasn't loaded
      // (e.g. standalone use of the academy module outside /pro).
      try {
        if (window.NBDAuth && typeof window.NBDAuth.hasAccess === 'function') {
          return window.NBDAuth.hasAccess(tier);
        }
      } catch (e) { /* fall through */ }
      // Owner bypass — claim-ONLY since the OWNER_EMAILS retirement
      // (2026-07-06): owner claim minted by mintOwnerClaims;
      // window._userClaims is populated by nbd-auth/dashboard-bootstrap,
      // so the academy respects the founder account even if NBDAuth
      // hasn't attached yet on a cold-load sequence.
      if (window._userClaims?.owner === true) return true;
      return tier === 'foundation';
    },

    _switchToCourseView(courseId, container) {
      this._currentCourse = courseId;
      this.renderCourse(container, courseId);
    },

    renderCourse(container, courseId) {
      const course = (window._academyCourses || []).find(c => c.id === courseId);

      if (!course) {
        container.innerHTML = '<div class="rda-empty-state"><p>Course not found</p></div>';
        return;
      }

      const progress = this._getCourseProgress(courseId);
      const progressPercent = progress.total > 0
        ? Math.round((progress.completed / progress.total) * 100)
        : 0;

      let html = `
        <button class="rda-back-btn" data-action="back-to-courses">
          ← Back to Courses
        </button>

        <div class="rda-lesson-header">
          <h2 class="rda-lesson-title">${course.title}</h2>
          <p style="margin: 10px 0 0 0; color: var(--rda-muted);">${course.description}</p>
          <div class="rda-progress-bar" style="margin-top: 16px;">
            <div class="rda-progress-fill" style="width: ${progressPercent}%"></div>
          </div>
          <div style="font-size: 12px; color: var(--rda-muted); margin-top: 8px;">
            ${progressPercent}% complete (${progress.completed}/${progress.total} lessons)
          </div>
        </div>

        <h3 class="rda-section-title">Modules & Lessons</h3>
      `;

      if (!course.modules || course.modules.length === 0) {
        html += '<div class="rda-empty-state"><p>No modules available</p></div>';
      } else {
        course.modules.forEach((mod, modIdx) => {
          html += `
            <div class="rda-module-accordion">
              <div class="rda-collapsible-header" style="background: var(--rda-dark2);">
                📚 ${mod.title}
                <span class="rda-collapsible-arrow">▼</span>
              </div>
              <div class="rda-collapsible-body">
          `;

          if (mod.lessons && mod.lessons.length > 0) {
            mod.lessons.forEach(lesson => {
              const lessonKey = `${courseId}_${lesson.id}`;
              const isComplete = this._progressData.completedLessons.has(lessonKey);
              const checkmark = isComplete ? '✓' : '';
              html += `
                <div class="rda-list-item" style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div style="font-weight: 700; color: var(--rda-light);">${lesson.title} ${checkmark}</div>
                    <div style="font-size: 12px; color: var(--rda-muted);">${lesson.duration}</div>
                  </div>
                  <button class="rda-button rda-button-small" data-action="open-lesson"
                    data-course-id="${courseId}" data-lesson-id="${lesson.id}">
                    Open
                  </button>
                </div>
              `;
            });
          }

          html += `
              </div>
            </div>
          `;
        });
      }

      container.innerHTML = html;

      // Events
      container.querySelector('[data-action="back-to-courses"]').addEventListener('click', () => {
        this._currentCourse = null;
        this.renderCourseList(container);
      });

      container.querySelectorAll('[data-action="open-lesson"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const courseId = e.target.dataset.courseId;
          const lessonId = e.target.dataset.lessonId;
          this.renderLesson(container, courseId, lessonId);
        });
      });

      // Module accordions — without this the auto-expand .click() below is a
      // no-op and lessons are unreachable from the course view.
      container.querySelectorAll('.rda-collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
          const isOpen = header.classList.toggle('open');
          header.nextElementSibling.classList.toggle('open', isOpen);
        });
      });

      // Open first module by default
      if (course.modules && course.modules.length > 0) {
        container.querySelector('.rda-collapsible-header').click();
      }
    },

    renderLesson(container, courseId, lessonId) {
      const course = (window._academyCourses || []).find(c => c.id === courseId);
      if (!course) return;

      let lesson = null;
      let module = null;

      for (const mod of course.modules || []) {
        const les = mod.lessons?.find(l => l.id === lessonId);
        if (les) {
          lesson = les;
          module = mod;
          break;
        }
      }

      if (!lesson) return;

      const lessonKey = `${courseId}_${lessonId}`;
      const isComplete = this._progressData.completedLessons.has(lessonKey);
      const quizKey = `${courseId}_${lessonId}`;
      const quizResult = this._progressData.quizScores[quizKey];

      let html = `
        <button class="rda-back-btn" data-action="back-to-course">
          ← Back to ${course.title}
        </button>

        <div class="rda-lesson-header">
          <h2 class="rda-lesson-title">${lesson.title}</h2>
          <p style="margin: 8px 0 0 0; color: var(--rda-muted);">${module.title} • ${lesson.duration}</p>
        </div>

        <div class="rda-lesson-content">
          ${lesson.content}
        </div>
      `;

      // Quiz section
      if (lesson.quiz) {
        html += '<h3 style="font-size: 18px; font-weight: 700; margin: 30px 0 20px 0;">Quiz</h3>';
        html += this._buildQuizHtml(lesson.quiz, quizResult);
      }

      html += `
        <div style="margin-top: 30px; display: flex; gap: 12px;">
          ${!isComplete && !quizResult ? `
            <button class="rda-button" data-action="mark-lesson-complete"
              data-course-id="${courseId}" data-lesson-id="${lessonId}">
              Mark Complete
            </button>
          ` : ''}
          ${isComplete ? '<span style="color: var(--rda-green);">✓ Completed</span>' : ''}
        </div>
      `;

      container.innerHTML = html;

      // Back button
      container.querySelector('[data-action="back-to-course"]').addEventListener('click', () => {
        this.renderCourse(container, courseId);
      });

      // Mark complete button
      const completeBtn = container.querySelector('[data-action="mark-lesson-complete"]');
      if (completeBtn) {
        completeBtn.addEventListener('click', () => {
          this.markLessonComplete(courseId, lessonId);
          this.renderLesson(container, courseId, lessonId);
        });
      }

      // Quiz submit
      const quizForm = container.querySelector('[data-action="submit-quiz"]');
      if (quizForm) {
        quizForm.addEventListener('click', () => {
          const answers = {};
          container.querySelectorAll('input[name^="q-"]').forEach(radio => {
            if (radio.checked) {
              answers[radio.name] = parseInt(radio.value);
            }
          });
          const result = this.submitQuiz(courseId, lessonId, answers);
          this.renderLesson(container, courseId, lessonId);
        });
      }

      // Retry quiz — clear the prior result so the answerable form returns.
      const retryBtn = container.querySelector('[data-action="retry-quiz"]');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          delete this._progressData.quizScores[quizKey];
          this._saveProgress();
          this.renderLesson(container, courseId, lessonId);
        });
      }
    },

    _buildQuizHtml(quiz, previousResult) {
      let html = '<div class="rda-quiz">';

      if (previousResult) {
        const status = previousResult.passed ? 'passed' : 'failed';
        const statusText = previousResult.passed ? 'Quiz Passed!' : 'Quiz Failed';
        html += `
          <div class="rda-quiz-result ${status}">
            <div class="rda-quiz-result-title">${statusText}</div>
            <div>Score: ${previousResult.score}/${previousResult.total}</div>
          </div>
        `;

        if (previousResult.feedback) {
          previousResult.feedback.forEach((item, idx) => {
            const resultClass = item.correct ? 'correct' : 'incorrect';
            html += `
              <div class="rda-question-result ${resultClass}">
                <strong>Q${idx + 1}:</strong> ${item.correct ? '✓ Correct' : '✗ Incorrect'}
                ${item.explanation ? `<div class="rda-quiz-feedback">${item.explanation}</div>` : ''}
              </div>
            `;
          });
        }

        // Retry control — without it a failed quiz strands the lesson
        // (Mark Complete is hidden once a result exists).
        html += `
          <button class="rda-button" data-action="retry-quiz" style="margin-top: 20px;">
            Retry Quiz
          </button>
        `;
      } else {
        quiz.questions.forEach((q, qIdx) => {
          html += `
            <div class="rda-quiz-question">
              <div class="rda-quiz-q">${qIdx + 1}. ${q.q}</div>
              <div class="rda-quiz-options">
          `;

          q.options.forEach((opt, optIdx) => {
            html += `
              <label class="rda-quiz-option">
                <input type="radio" name="q-${qIdx}" value="${optIdx}">
                <label>${opt}</label>
              </label>
            `;
          });

          html += '</div></div>';
        });

        html += `
          <button class="rda-button" data-action="submit-quiz" style="margin-top: 20px;">
            Submit Quiz
          </button>
        `;
      }

      html += '</div>';
      return html;
    },

    // ===== TAB: ASSIGNMENTS =====
    renderAssignments(container) {
      // Placeholder implementation
      container.innerHTML = `
        <h2 class="rda-section-title">My Assignments</h2>
        <div class="rda-empty-state">
          <div class="rda-empty-icon">📋</div>
          <div class="rda-empty-title">No Assignments</div>
          <div class="rda-empty-text">You don't have any assigned items at this time.</div>
        </div>
      `;
    },

    // ===== PROGRESS API =====
    markNodeComplete(nodeId) {
      this._progressData.completedNodes.add(nodeId);
      this._saveProgress();
    },

    markLessonComplete(courseId, lessonId) {
      const key = `${courseId}_${lessonId}`;
      this._progressData.completedLessons.add(key);
      this._saveProgress();
    },

    submitQuiz(courseId, lessonId, answers) {
      const course = (window._academyCourses || []).find(c => c.id === courseId);
      if (!course) return { passed: false, score: 0, total: 0 };

      let lesson = null;
      for (const mod of course.modules || []) {
        const les = mod.lessons?.find(l => l.id === lessonId);
        if (les) {
          lesson = les;
          break;
        }
      }

      if (!lesson || !lesson.quiz) return { passed: false, score: 0, total: 0 };

      let score = 0;
      const feedback = [];

      lesson.quiz.questions.forEach((q, idx) => {
        const userAnswer = answers[`q-${idx}`];
        const isCorrect = userAnswer === q.correct;
        if (isCorrect) score++;

        feedback.push({
          correct: isCorrect,
          explanation: q.explanation || ''
        });
      });

      const total = lesson.quiz.questions.length;
      const passed = (score / total) >= 0.7; // 70% pass threshold

      const key = `${courseId}_${lessonId}`;
      this._progressData.quizScores[key] = {
        passed,
        score,
        total,
        feedback,
        timestamp: new Date().toISOString()
      };

      // Auto-complete lesson if quiz passed
      if (passed) {
        this.markLessonComplete(courseId, lessonId);
      }

      this._saveProgress();
      return { passed, score, total };
    },

    getCompletionStats() {
      const insuranceTree = window._academyInsuranceTree || [];
      const retailTree = window._academyRetailTree || [];
      const courses = window._academyCourses || [];

      const totalNodes = insuranceTree.length + retailTree.length;
      const nodesComplete = this._progressData.completedNodes.size;

      let totalLessons = 0;
      let lessonsComplete = 0;
      let totalQuizzes = 0;

      courses.forEach(course => {
        if (course.modules) {
          course.modules.forEach(mod => {
            if (mod.lessons) {
              mod.lessons.forEach(lesson => {
                totalLessons++;
                if (lesson.quiz) {
                  totalQuizzes++;
                }
                if (this._progressData.completedLessons.has(`${course.id}_${lesson.id}`)) {
                  lessonsComplete++;
                }
              });
            }
          });
        }
      });

      const quizScores = Object.values(this._progressData.quizScores);
      const quizzesPassed = quizScores.filter(q => q.passed).length;

      // Average only over attempts with a valid denominator — a q.total of 0
      // would make q.score / q.total a divide-by-zero (NaN/Infinity).
      const scored = quizScores.filter(q => q.total > 0);
      let avgScore = 0;
      if (scored.length > 0) {
        const totalScore = scored.reduce((sum, q) => sum + (q.score / q.total * 100), 0);
        avgScore = Math.round(totalScore / scored.length);
      }

      return {
        nodesComplete,
        totalNodes,
        lessonsComplete,
        totalLessons,
        quizzesPassed,
        totalQuizzes,
        avgScore
      };
    },

    _isAdmin() {
      // Admin role is set server-side (Firebase custom claim → NBDAuth._role).
      // NEVER trust localStorage for privilege: any user can open DevTools
      // and set the key, so the old `nbd_admin_user === 'true'` check
      // was an auth bypass. Delegate to NBDAuth.isAdmin when available
      // (it's fail-closed and checks owner-email + claim), and fall back
      // to the window.currentUser.role assignment which itself should only
      // ever be populated from a verified claim.
      try {
        if (window.NBDAuth && typeof window.NBDAuth.isAdmin !== 'undefined') {
          return !!window.NBDAuth.isAdmin;
        }
      } catch (_) { /* fall through */ }
      return !!(window.currentUser && window.currentUser.role === 'admin');
    }
  };

  // ===== EXPORT =====
  window.RealDealAcademy = RealDealAcademy;

  if (typeof console !== 'undefined' && console.log) {
    console.log('Real Deal Academy engine loaded. Call window.RealDealAcademy.init() to start.');
  }
})();
