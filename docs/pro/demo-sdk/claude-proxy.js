// claude-proxy.js (sample account) — Pro demo phase 2, wave 3, 2026-10-06.
//
// Under /pro/explore/ the demo service worker (docs/pro/explore/demo-sw.js,
// SWAPS) answers the CRM's js/claude-proxy.js with this file. The real one
// POSTs every AI request to the claudeProxy Cloud Function, which calls the
// model. This one never makes a request: window.callClaude hands Ask Joe's
// turns to the sample answers (docs/pro/demo-sdk/offline.js →
// ask-joe-canned.js) and tells any other AI feature that AI is not in the
// sample account. Same two globals as the real file.
(function () {
  'use strict';
  var demo = window.__NBD_DEMO__;
  window.callClaude = function (params) {
    if (demo && typeof demo.sampleClaude === 'function') return demo.sampleClaude(params);
    return Promise.reject(new Error('AI is not in the sample account.'));
  };
  window.callClaude.__nbdDemo = true;
  window.resetClaudeProxyCheck = function () {};
})();
