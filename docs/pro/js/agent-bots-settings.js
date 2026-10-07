/**
 * agent-bots-settings.js — Settings → 🤖 Bots & API (2026-10-04).
 *
 * Any NBD Pro company on a paid plan connects its OWN AI bots (Claude,
 * ChatGPT, Grok — anything that speaks MCP) to its CRM through the bot
 * connection (functions/agent-mcp.js, /api/mcp), the way Jo's Grok team does.
 *
 *   owner / admin   make a bot (name, what it does, the tools it may use, who
 *                   its filings notify), mint a key (shown ONCE — only its hash
 *                   is stored), see every company key with its last use,
 *                   revoke, remove a bot; the company's on/off switch, its
 *                   timezone and its house rules for bots
 *   anyone else     their own keys (personal tracker bots) — list + revoke
 *   NBD only        the house team (Marcus, Quinn, …) as before
 *
 * Safety model (unchanged): bots READ minimized CRM data and FILE notes,
 * reminders and reports into the Agent inbox. Nothing a bot does is sent to a
 * customer — there is no send call anywhere in the connection or this file.
 *
 * Renders into #agentBotsMount when the 'bots' Settings tab opens
 * (switchSettingsTab is wrapped, the ai-texting-persona.js pattern).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const TZS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
  const TOOL_LABELS = {
    crm_summary: 'Pipeline at a glance', schedule: 'Day schedule', overdue_followups: 'Overdue follow-ups',
    list_leads: 'Customer list', lead_detail: 'One customer (notes, open reminders)', file_note: 'File a note',
    file_reminder: 'File a reminder', file_report: 'File a report', inbox_pending: 'Read the Agent inbox',
    verify_item: 'Fact-check inbox items', estimates_status: 'Estimates + proposal status', rules_reference: 'Your rules',
    post_job: 'Finished jobs', lead_sources: 'Lead sources + spend', job_profit: 'Job profit (internal)',
    storm_near_customers: 'Storms near customers', team_activity: 'What your bots did', collected_revenue: 'Collected revenue',
  };
  const STARTER = ['crm_summary', 'schedule', 'overdue_followups', 'list_leads', 'lead_detail', 'file_note', 'file_reminder', 'file_report', 'rules_reference'];

  let _data = null;
  let _fresh = null;
  let _busy = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof window.showToast === 'function') window.showToast(m, k || 'info'); };
  function browserTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } }
  // The app's themed dialog in the installed app (standalone-compat.js);
  // the browser's own confirm everywhere else — a revoke always asks.
  const ask = async (m) => (typeof window.nbdConfirm === 'function' ? !!(await window.nbdConfirm(m)) : window.confirm(m));
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');

  async function callable(name, payload) {
    if (!window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._httpsCallable = mod.httpsCallable;
    }
    if (!window._functions) throw new Error('Functions SDK unavailable');
    const res = await window._httpsCallable(window._functions, name)(payload || {});
    return res && res.data;
  }

  /** The MCP client config a bot needs (pure). The key stays a placeholder. */
  function exampleConfig(url, botName) {
    const slug = String(botName || 'crm').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'crm';
    return JSON.stringify({ mcpServers: { [slug]: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:Bearer ${CRM_KEY}'], env: { CRM_KEY: 'paste-your-key-here' } } } }, null, 2);
  }

  /** Active keys grouped by bot id (pure). */
  function groupKeys(keys) {
    const out = {};
    (keys || []).filter((k) => k && k.active).forEach((k) => { (out[k.botId] = out[k.botId] || []).push(k); });
    return out;
  }

  function keyRows(ks) {
    return (ks || []).map((k) => '<div class="ab-key-row"><span class="ab-mono">' + esc(k.prefix) + '…</span>' +
      '<span class="ab-meta">made ' + esc(when(k.createdAt)) + ' · last used ' + esc(when(k.lastUsedAt)) + '</span>' +
      '<button type="button" class="ab-link-btn" data-ab-act="revoke" data-ab-id="' + esc(k.id) + '">Revoke</button></div>').join('');
  }

  function freshHtml(d) {
    if (!_fresh) return '';
    return '<div class="ab-card ab-fresh" id="abFresh">' +
      '<div class="ab-h3">New key for ' + esc(_fresh.botName) + '</div>' +
      '<p class="ab-warn">Copy it now — it is shown once. We keep only a scrambled copy, so it cannot be shown again. Lost it? Revoke it and make a new one.</p>' +
      '<code class="ab-key" id="abFreshKey">' + esc(_fresh.key) + '</code>' +
      '<div class="ab-row"><button type="button" class="ab-btn is-primary" data-ab-act="copykey">Copy key</button>' +
      '<button type="button" class="ab-btn" data-ab-act="hidekey">I saved it</button></div>' +
      '<div class="ab-meta">Connection address: <span class="ab-mono">' + esc(_fresh.url || d.url) + '</span> · header <span class="ab-mono">Authorization: Bearer &lt;key&gt;</span></div>' +
      '<details class="ab-details"><summary>Example config (Claude Desktop and other MCP clients)</summary><pre class="ab-pre">' + esc(exampleConfig(_fresh.url || d.url, _fresh.botName)) + '</pre></details>' +
      '<div class="ab-meta">Put the key in the bot’s secret / environment setting — never paste it into a chat.</div></div>';
  }

  function botCard(b, keysByBot, d) {
    const ks = keysByBot[b.botId] || [];
    const tools = (b.tools || []).map((t) => '<span class="ab-chip">' + esc(TOOL_LABELS[t] || t) + '</span>').join('');
    return '<div class="ab-bot" data-ab-bot="' + esc(b.botId) + '">' +
      '<div class="ab-bot-top"><div><div class="ab-h3">' + esc(b.name) + '</div>' + (b.role ? '<div class="ab-meta">' + esc(b.role) + '</div>' : '') + '</div></div>' +
      '<div class="ab-chips">' + tools + '</div>' +
      (b.routeTo ? '<div class="ab-meta">Notifies: ' + (b.routeTo === 'creator' ? 'the person who made it' : 'the company owner') + '</div>' : '') +
      keyRows(ks) +
      '<div class="ab-row">' + (d.enabled && d.planOk ? '<button type="button" class="ab-btn" data-ab-act="mkkey" data-ab-id="' + esc(b.botId) + '">' + (ks.length ? 'New key' : 'Create key') + '</button>' : '') +
      (b.custom ? '<button type="button" class="ab-btn is-danger" data-ab-act="rmbot" data-ab-id="' + esc(b.botId) + '">Remove bot</button>' : '') + '</div></div>';
  }

  function newBotForm(d) {
    const tools = (d.toolCatalog || []).map((t) => '<label class="ab-tool"><input type="checkbox" name="abTool" value="' + esc(t.name) + '"' + (STARTER.indexOf(t.name) !== -1 ? ' checked' : '') + '>' +
      '<span><b>' + esc(TOOL_LABELS[t.name] || t.name) + '</b>' + (t.files ? ' <span class="ab-tag">files to inbox</span>' : '') + '<span class="ab-meta ab-block">' + esc(t.description) + '</span></span></label>').join('');
    return '<div class="ab-card" id="abNewBot"><div class="ab-h3">Make a bot</div>' +
      '<label class="ab-label" for="abBotName">Name</label><input class="ab-input" id="abBotName" maxlength="60" placeholder="e.g. Follow-up helper" autocomplete="off">' +
      '<label class="ab-label" for="abBotRole">What it does</label><textarea class="ab-input" id="abBotRole" maxlength="300" rows="2" placeholder="e.g. Each morning, finds customers who went quiet and files a reminder"></textarea>' +
      '<div class="ab-label">Tools it may use</div><div class="ab-tools">' + tools + '</div>' +
      '<label class="ab-label" for="abBotRoute">Its filings notify</label><select class="ab-input" id="abBotRoute"><option value="owner">The company owner</option><option value="creator">Me</option></select>' +
      '<button type="button" class="ab-btn is-primary ab-wide" data-ab-act="mkbot" id="abMkBot">Create bot</button></div>';
  }

  function settingsCard(d) {
    const cur = d.timezone || '';
    const list = TZS.slice();
    const bz = browserTz();
    if (bz && list.indexOf(bz) === -1) list.push(bz);
    if (cur && list.indexOf(cur) === -1) list.push(cur);
    const opts = list.map((z) => '<option value="' + esc(z) + '"' + (z === cur ? ' selected' : '') + '>' + esc(z.replace(/_/g, ' ')) + '</option>').join('');
    return '<div class="ab-card"><div class="ab-h3">Company settings for bots</div>' +
      '<label class="ab-switch"><input type="checkbox" id="abEnabled" data-ab-change="enabled"' + (d.enabled ? ' checked' : '') + '> <span>Bots are ' + (d.enabled ? 'on' : 'off') + ' for this company</span></label>' +
      '<div class="ab-meta">Off stops every bot key of this company right away. Turn it back on and the same keys work again.</div>' +
      '<label class="ab-label" for="abTz">Timezone (what "today" means to your bots)</label>' +
      '<select class="ab-input" id="abTz">' + (d.timezoneSet ? '' : '<option value="">Not set — pick yours</option>') + opts + '</select>' +
      (d.timezoneSet ? '' : '<div class="ab-warn">No timezone set yet — bots count days in UTC until you pick one.</div>') +
      '<label class="ab-label" for="abRules">House rules for your bots (one per line)</label>' +
      '<textarea class="ab-input" id="abRules" rows="4" maxlength="3000" placeholder="e.g. Always offer gutter guards with a roof.&#10;Never quote a price over the phone.">' + esc(d.houseRules || '') + '</textarea>' +
      '<div class="ab-meta">Bots read these with the rules tool, along with your tiers, prices and deposit rule from Settings.</div>' +
      '<button type="button" class="ab-btn is-primary ab-wide" data-ab-act="savesettings">Save</button></div>';
  }

  /** The whole page (pure over the listAgentKeys answer). */
  function pageHtml(d) {
    const keysByBot = groupKeys(d.keys);
    const head = '<div class="ab-card"><div class="ab-h2">🤖 Bots &amp; API</div>' +
      '<p class="ab-p">Connect your own AI assistant — Claude, ChatGPT, Grok or any app that speaks MCP — to your CRM. A bot reads what you allow and files notes, reminders and reports into your Agent inbox. <b>Nothing a bot does is ever sent to a customer</b>; you decide what lands on a customer’s card.</p>' +
      '<div class="ab-meta">Connection address</div><div class="ab-row"><code class="ab-key ab-grow" id="abUrl">' + esc(d.url) + '</code><button type="button" class="ab-btn" data-ab-act="copyurl">Copy</button></div>' +
      '<div class="ab-row">' + (d.canManage ? '<button type="button" class="ab-btn" data-ab-act="inbox">Open Agent inbox</button>' : '') +
      '<a class="ab-btn ab-a" href="/pro/how-to.html#connect-bots" target="_blank" rel="noopener">How to connect a bot</a></div></div>';
    const gate = !d.planOk && !d.isNbd
      ? '<div class="ab-card ab-gate"><div class="ab-h3">Bots need a paid plan</div><p class="ab-p">Your company is on the ' + esc(d.plan || 'free') + ' plan. Connecting your own bots comes with every paid plan.</p>' +
        (d.canManage ? '<button type="button" class="ab-btn is-primary" data-ab-act="billing">See plans</button>' : '') + '</div>'
      : '';
    const off = d.planOk && !d.enabled ? '<div class="ab-card ab-gate"><div class="ab-h3">Bots are switched off</div><p class="ab-p">Every bot key of this company is refused until ' + (d.canManage ? 'you turn bots back on below' : 'the owner turns them back on') + '.</p></div>' : '';
    const custom = (d.customBots || []).map((b) => Object.assign({ custom: true }, b));
    const house = (d.bots || []).filter((b) => !b.personal);
    const personal = (d.bots || []).filter((b) => b.personal);
    let body = '';
    if (d.canManage) {
      body += settingsCard(d);
      if (d.planOk && d.enabled) body += newBotForm(d);
      body += '<div class="ab-card"><div class="ab-h3">Your company’s bots</div>' +
        (custom.length ? custom.map((b) => botCard(b, keysByBot, d)).join('') : '<div class="ab-empty" id="abNoBots">No bots yet. Make one above, then create its key.</div>') + '</div>';
      if (house.length) body += '<div class="ab-card"><div class="ab-h3">NBD house team</div>' + house.map((b) => botCard(b, keysByBot, d)).join('') + '</div>';
    }
    if (personal.length) {
      body += '<div class="ab-card"><div class="ab-h3">Personal — reads only your own Daily tracker, never the CRM</div>' +
        personal.map((b) => botCard(b, keysByBot, Object.assign({}, d, { enabled: true, planOk: true }))).join('') + '</div>';
    }
    if (!d.canManage) {
      const mine = (d.keys || []).filter((k) => k.active && !k.personal);
      if (mine.length) body += '<div class="ab-card"><div class="ab-h3">Your keys</div>' + keyRows(mine) + '</div>';
      body += '<div class="ab-meta ab-pad">Company bots are set up by the owner or an admin.</div>';
    }
    return freshHtml(d) + head + gate + off + body;
  }

  // What the owner has typed but not saved. Opening the tab fires load() more
  // than once (the ?settings=bots deep link, goTo's own tab timer, the
  // hashchange re-entry), and every load replaces the whole mount. A form
  // rendered by the first answer and filled in was wiped by the next one, so
  // "Create bot" read an empty name and stopped at "Give the bot a name" —
  // on a slow phone, and in CI (phone-bots-api.spec.js). Each render now
  // carries the unsaved form across, and only the newest load may render.
  const FORM_IDS = ['abBotName', 'abBotRole', 'abBotRoute', 'abTz', 'abRules'];
  function readForm(mount) {
    if (!mount.querySelector('#abNewBot, #abTz')) return null;
    const vals = {};
    FORM_IDS.forEach((id) => { const el = mount.querySelector('#' + id); if (el) vals[id] = el.value; });
    const tools = mount.querySelector('input[name="abTool"]')
      ? Array.prototype.slice.call(mount.querySelectorAll('input[name="abTool"]:checked')).map((i) => i.value) : null;
    return { vals, tools };
  }
  function restoreForm(mount, snap) {
    if (!snap) return;
    FORM_IDS.forEach((id) => {
      const el = mount.querySelector('#' + id);
      if (!el || !(id in snap.vals)) return;
      // A select keeps its fresh value when the saved one is no longer offered.
      if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options || [], (o) => o.value === snap.vals[id])) return;
      el.value = snap.vals[id];
    });
    if (snap.tools) {
      Array.prototype.slice.call(mount.querySelectorAll('input[name="abTool"]')).forEach((i) => { i.checked = snap.tools.indexOf(i.value) !== -1; });
    }
  }

  let _loadSeq = 0;
  async function load(opts) {
    const mount = document.getElementById('agentBotsMount');
    if (!mount) return;
    const seq = ++_loadSeq;
    if (!_data) mount.innerHTML = '<div class="ab-meta ab-pad">Loading…</div>';
    try {
      const d = await callable('listAgentKeys');
      if (seq !== _loadSeq) return; // a newer load is on its way; it renders
      _data = d;
      const snap = opts && opts.reset ? null : readForm(mount);
      mount.innerHTML = pageHtml(_data);
      restoreForm(mount, snap);
    } catch (e) {
      if (seq !== _loadSeq) return;
      mount.innerHTML = '<div class="ab-card"><div class="ab-meta">Could not load bots: ' + esc((e && e.message) || 'error') + '</div></div>';
    }
  }

  function selectedTools() {
    return Array.prototype.slice.call(document.querySelectorAll('#agentBotsMount input[name="abTool"]:checked')).map((i) => i.value);
  }

  async function act(t) {
    const a = t.dataset.abAct, id = t.dataset.abId;
    if (a === 'copyurl' || a === 'copykey') {
      const el = document.getElementById(a === 'copyurl' ? 'abUrl' : 'abFreshKey');
      try { await navigator.clipboard.writeText(el ? el.textContent : ''); toast(a === 'copyurl' ? 'Address copied' : 'Key copied — put it in your bot’s secret setting', 'success'); } catch (_) { toast('Copy failed — select it and copy by hand', 'error'); }
      return;
    }
    if (a === 'hidekey') { _fresh = null; return load(); }
    if (a === 'inbox') { if (window.NBDAgentInbox && window.NBDAgentInbox.open) window.NBDAgentInbox.open(); return; }
    if (a === 'billing') { if (typeof window.switchSettingsTab === 'function') window.switchSettingsTab('billing'); return; }
    if (_busy) return;
    _busy = true; t.disabled = true;
    try {
      if (a === 'mkbot') {
        const name = (document.getElementById('abBotName') || {}).value || '';
        const role = (document.getElementById('abBotRole') || {}).value || '';
        const routeTo = (document.getElementById('abBotRoute') || {}).value || 'owner';
        if (!name.trim()) { toast('Give the bot a name', 'error'); return; }
        const tools = selectedTools();
        if (!tools.length) { toast('Pick at least one tool', 'error'); return; }
        const r = await callable('saveAgentBot', { name, role, tools, routeTo, timezone: browserTz() });
        toast('Bot created — now create its key', 'success');
        _fresh = null;
        await load({ reset: true }); // the bot is made: start the form over
        const card = r && r.botId && document.querySelector('[data-ab-bot="' + r.botId + '"]');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center' });
      } else if (a === 'mkkey') {
        _fresh = await callable('createAgentKey', { botId: id });
        await load();
        const f = document.getElementById('abFresh');
        if (f && f.scrollIntoView) f.scrollIntoView({ block: 'start' });
      } else if (a === 'revoke') {
        const sure = await ask('Revoke this key? The bot loses access until you make a new one.');
        if (!sure) return;
        await callable('revokeAgentKey', { id });
        toast('Key revoked', 'success');
        await load();
      } else if (a === 'rmbot') {
        const sure = await ask('Remove this bot? Its keys stop working right away.');
        if (!sure) return;
        await callable('deleteAgentBot', { botId: id });
        toast('Bot removed', 'success');
        await load();
      } else if (a === 'savesettings') {
        const tz = (document.getElementById('abTz') || {}).value || '';
        const houseRules = (document.getElementById('abRules') || {}).value || '';
        await callable('saveAgentSettings', { timezone: tz, houseRules });
        toast('Saved', 'success');
        await load();
      }
    } catch (e) {
      toast((e && e.message) || 'That did not work', 'error');
    } finally { _busy = false; t.disabled = false; }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest && ev.target.closest('#agentBotsMount [data-ab-act]');
    if (t && t.tagName !== 'A') act(t);
  });
  document.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (!t || !t.matches || !t.matches('#agentBotsMount [data-ab-change="enabled"]')) return;
    const on = !!t.checked;
    if (!on && !(await ask('Turn bots off? Every bot key of this company stops working until you turn them back on.'))) { t.checked = true; return; }
    t.disabled = true;
    try { await callable('saveAgentSettings', { enabled: on }); toast(on ? 'Bots are on' : 'Bots are off', 'success'); await load(); }
    catch (e) { t.checked = !on; toast((e && e.message) || 'Could not save', 'error'); t.disabled = false; }
  });

  // Open Settings on this tab (from the Agent inbox or a link).
  async function openTab() {
    if (typeof window.goTo === 'function') window.goTo('settings', { id: 'bots' });
    for (let i = 0; i < 40; i++) {
      if (typeof window.switchSettingsTab === 'function' && document.getElementById('stab-panel-bots')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (typeof window.switchSettingsTab === 'function') window.switchSettingsTab('bots');
  }

  function installTabHook() {
    const prev = window.switchSettingsTab;
    if (typeof prev !== 'function') return false;
    if (prev.__abWrapped) return true;
    const wrapped = function (tab) {
      prev.apply(this, arguments);
      if (tab === 'bots') load();
    };
    wrapped.__abWrapped = true;
    window.switchSettingsTab = wrapped;
    // This file loads BEFORE ui.js defines switchSettingsTab, so the hook goes
    // on up to one poll tick late. A deep link (?settings=bots) or the hash
    // router can open the tab inside that gap — the panel showed, nothing ever
    // called load(), and the tab sat empty. Catch up if it is already open.
    const panel = document.getElementById('stab-panel-bots');
    if (panel && panel.style && panel.style.display === 'block' && !_loadSeq) load();
    return true;
  }
  function boot() {
    if (installTabHook()) return;
    let tries = 0;
    const iv = setInterval(() => { if (installTabHook() || ++tries > 120) clearInterval(iv); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDAgentBots = { open: openTab, load, pageHtml, exampleConfig, groupKeys, TOOL_LABELS };
})();
