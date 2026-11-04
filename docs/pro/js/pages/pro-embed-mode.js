/**
 * NBD Pro — embedded-pane marker for the dashboard's tool pages.
 * Loaded (defer, external: strict CSP) by analytics.html, ai-tree.html,
 * understand.html and project-codex.html, which the dashboard shows in iframes
 * (AI Usage, Decision Engine, Understand, Project Codex).
 *
 * Framed, the page's own top bar only repeats the dashboard's, and its
 * "Back to Dashboard" / nav links navigate the FRAME to /pro/dashboard or
 * /pro/login, which firebase.json serves with frame-ancestors 'none': the pane
 * went blank. Each page hides that chrome under html.nbd-embedded in its own
 * <style>. Opened on its own the page is unchanged.
 */
(function () {
  var root = document.documentElement;
  try { if (window.self !== window.top) root.classList.add('nbd-embedded'); } catch (_) { root.classList.add('nbd-embedded'); }
})();
