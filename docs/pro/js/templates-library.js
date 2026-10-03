/**
 * templates-library.js — Wave 97 (SMS/Email templates library)
 *
 * Opens the eighth arc — productivity polish on the message
 * composition flow. Reps currently retype the same follow-up
 * text dozens of times a week. W97 introduces a local templates
 * library so they can save canned messages and pick one before
 * sending.
 *
 * Data shape (per template):
 *   {
 *     id:        string  (uuid-ish, generated)
 *     name:      string  (rep-facing label, e.g. "Initial follow-up")
 *     channel:   'sms' | 'email'
 *     subject:   string  (email only, optional for sms)
 *     body:      string  (with placeholder tokens — see apply())
 *     createdAt: ms timestamp
 *     updatedAt: ms timestamp
 *   }
 *
 * Persisted to localStorage as `nbd_templates_v1` JSON array.
 * Per-device only (matches the W37 / W78 preference pattern).
 *
 * Placeholder tokens supported by apply():
 *   {firstName}    — lead.firstName
 *   {lastName}     — lead.lastName
 *   {fullName}     — concatenated first + last (or "there" if missing)
 *   {greeting}     — "Hi {firstName}, " or "Hi, "
 *   {address}      — lead.address (first line)
 *   {portalUrl}    — generated portal URL (passed in)
 *   {repName}      — current rep's display name (window._currentRep)
 *   {repPhone}     — current rep's phone (window._currentRep)
 *
 * On first run, seeds three default templates so the rep has
 * something to use immediately. Defaults are flagged with a
 * `_seeded: true` marker so we can detect & migrate the seeds
 * across schema changes without overwriting the rep's edits.
 *
 * Compounds W41 (smsForLead prefilled body) + W43 (emailForLead
 * prefilled body). Wave 98 will wire `apply()` into PortalLinkHelpers
 * so reps can pick a template before send.
 *
 * Exposes:
 *   window.TemplatesLibrary.list(channel?)
 *   window.TemplatesLibrary.get(id)
 *   window.TemplatesLibrary.save(template)
 *   window.TemplatesLibrary.remove(id)
 *   window.TemplatesLibrary.apply(template, ctx)
 *   window.TemplatesLibrary.openManager()
 */
(function () {
  'use strict';

  if (window.TemplatesLibrary
      && window.TemplatesLibrary.__sentinel === 'nbd-templates-library-v1') return;

  const STORAGE_KEY = 'nbd_templates_v1';
  const SEEDED_FLAG_KEY = 'nbd_templates_seeded_v1';

  // ─── Helpers ─────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function newId() {
    // Simple unique-ish id — collision risk is irrelevant for a
    // per-device list of <50 entries. Avoids importing crypto.
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function _read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function _write(arr) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr || [])); } catch (_) {}
  }

  function _toast(msg, kind) {
    if (typeof window.showToast === 'function') return window.showToast(msg, kind);
    if (typeof window.toast === 'function') return window.toast(msg);
    console.log('[Templates]', msg);
  }

  // ─── Seed defaults ──────────────────────────────────────────────
  function seedDefaults() {
    if (localStorage.getItem(SEEDED_FLAG_KEY) === '1') return;
    const existing = _read();
    if (existing.length > 0) {
      // Rep already has templates — don't overwrite.
      localStorage.setItem(SEEDED_FLAG_KEY, '1');
      return;
    }
    const now = Date.now();
    const seeds = [
      {
        id: newId(),
        name: 'Portal link · initial',
        channel: 'sms',
        body: '{greeting}here\'s your project portal — photos, status updates, and what\'s coming next: {portalUrl}',
        createdAt: now, updatedAt: now, _seeded: true,
      },
      {
        id: newId(),
        name: 'Portal link · email',
        channel: 'email',
        subject: 'Your project portal — photos, status, and next steps',
        body:
`{greeting}

Here\'s your project portal — photos from your inspection / install, status updates, and what\'s coming next:

{portalUrl}

Bookmark it; the link stays live as we work through the project.

— {repName}`,
        createdAt: now, updatedAt: now, _seeded: true,
      },
      {
        id: newId(),
        name: 'Following up',
        channel: 'sms',
        body: '{greeting}just checking in on the estimate I sent — any questions? Happy to walk through it: {portalUrl}',
        createdAt: now, updatedAt: now, _seeded: true,
      },
    ];
    _write(seeds);
    localStorage.setItem(SEEDED_FLAG_KEY, '1');
  }

  // ─── CRUD ───────────────────────────────────────────────────────
  function list(channel) {
    const all = _read();
    if (!channel) return all;
    return all.filter(t => t && t.channel === channel);
  }
  function get(id) {
    return _read().find(t => t && t.id === id) || null;
  }
  function save(template) {
    if (!template || typeof template !== 'object') throw new Error('template object required');
    if (!template.channel || (template.channel !== 'sms' && template.channel !== 'email')) {
      throw new Error('channel must be "sms" or "email"');
    }
    if (!template.name || typeof template.name !== 'string') throw new Error('name required');
    if (typeof template.body !== 'string') throw new Error('body required');

    const all = _read();
    const now = Date.now();
    if (template.id) {
      const i = all.findIndex(t => t && t.id === template.id);
      if (i >= 0) {
        all[i] = { ...all[i], ...template, updatedAt: now };
      } else {
        all.push({ ...template, createdAt: now, updatedAt: now });
      }
    } else {
      all.push({ ...template, id: newId(), createdAt: now, updatedAt: now });
    }
    _write(all);
    return all[all.findIndex(t => t.id === template.id) >= 0
      ? all.findIndex(t => t.id === template.id)
      : all.length - 1];
  }
  function remove(id) {
    const all = _read();
    const next = all.filter(t => t && t.id !== id);
    _write(next);
    return next.length !== all.length;
  }

  // Wave 99: ⭐ default-template per channel. setDefault(id) flags
  // a template as default and clears the flag on every other
  // template of the same channel — single-default-per-channel
  // invariant. setDefault(null, channel) clears any default for
  // that channel.
  function setDefault(id, channelHint) {
    const all = _read();
    const target = id ? all.find(t => t && t.id === id) : null;
    const channel = (target && target.channel) || channelHint;
    if (!channel) return false;
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < all.length; i++) {
      const t = all[i];
      if (!t || t.channel !== channel) continue;
      const wasDefault = !!t.isDefault;
      const shouldBeDefault = !!target && t.id === target.id;
      if (wasDefault !== shouldBeDefault) {
        all[i] = { ...t, isDefault: shouldBeDefault, updatedAt: now };
        changed = true;
      }
    }
    if (changed) _write(all);
    return changed;
  }
  function getDefault(channel) {
    if (!channel) return null;
    return _read().find(t => t && t.channel === channel && t.isDefault) || null;
  }

  // ─── Apply (placeholder substitution) ────────────────────────────
  function apply(template, ctx) {
    if (!template) return '';
    const lead = (ctx && ctx.lead) || {};
    const url  = (ctx && ctx.url)  || '';
    const repName  = (ctx && ctx.repName)
      || (window._currentRep && (window._currentRep.displayName || window._currentRep.name))
      || 'No Big Deal Home Solutions';
    const repPhone = (ctx && ctx.repPhone)
      || (window._currentRep && window._currentRep.phone)
      || '';

    const firstName = String(lead.firstName || '').trim();
    const lastName  = String(lead.lastName  || '').trim();
    const fullName  = (firstName + ' ' + lastName).trim() || 'there';
    const greeting  = firstName ? `Hi ${firstName}, ` : 'Hi, ';
    const address   = String(lead.address || '').split(',')[0].trim();

    const tokens = {
      '{firstName}': firstName,
      '{lastName}':  lastName,
      '{fullName}':  fullName,
      '{greeting}':  greeting,
      '{address}':   address,
      '{portalUrl}': url,
      '{repName}':   repName,
      '{repPhone}':  repPhone,
    };
    let body = template.body || '';
    for (const [k, v] of Object.entries(tokens)) {
      body = body.split(k).join(v);
    }
    let subject = template.subject || '';
    for (const [k, v] of Object.entries(tokens)) {
      subject = subject.split(k).join(v);
    }
    return { body, subject };
  }

  // ─── Manager modal (basic CRUD UI) ──────────────────────────────
  let _modalOpen = false;
  function openManager(channel) {
    if (_modalOpen) return;
    _modalOpen = true;
    const overlay = document.createElement('div');
    overlay.id = 'nbd-templates-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'nbd-templates-title');
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:var(--z-overlay,10000);
      display:flex; align-items:center; justify-content:center; padding:20px;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;`;

    function renderList() {
      const all = list(channel);
      const items = all.map(t => {
        // W99: ⭐ default per-channel marker. Pinned templates get
        // a filled star + a pinned border-tint so they read as
        // distinct in the list.
        const isDef = !!t.isDefault;
        const star = isDef ? '⭐' : '☆';
        const starColor = isDef ? '#fbbf24' : 'var(--m,#9aa3b2)';
        const rowBorder = isDef ? '#fbbf24' : 'var(--br,#2a3344)';
        return `
        <div style="display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid ${rowBorder}; border-radius:8px; margin-bottom:6px; background:var(--s2,#0f1419);">
          <button data-template-pin="${escapeHtml(t.id)}" type="button"
            aria-label="${isDef ? 'Unpin default' : 'Pin as default for ' + escapeHtml(t.channel.toUpperCase())}"
            aria-pressed="${isDef ? 'true' : 'false'}"
            title="${isDef ? 'Unpin default' : 'Pin as default for ' + t.channel.toUpperCase()}"
            style="background:transparent; color:${starColor}; border:none; font-size:16px; line-height:1; cursor:pointer; padding:4px 6px; -webkit-tap-highlight-color:transparent;">
            <span aria-hidden="true">${star}</span>
          </button>
          <div class="tlx-fx1-minw0">
            <div class="tlx-fs13px-w600-ct">
              <span style="display:inline-block; padding:1px 6px; border-radius:8px; font-size:9px; margin-right:6px; ${t.channel === 'sms' ? 'background:rgba(59,130,246,0.18); color:#3b82f6;' : 'background:rgba(139,92,246,0.18); color:#8b5cf6;'}">${t.channel.toUpperCase()}</span>
              ${escapeHtml(t.name)}${t._seeded ? ' <span class="tlx-fs9px-cm">· seed</span>' : ''}${isDef ? ' <span class="tlx-fs9px-cfbbf24-w700">· DEFAULT</span>' : ''}
            </div>
            <div class="tlx-fs11px-cm-mt3px">${escapeHtml((t.body || '').slice(0, 90))}${(t.body || '').length > 90 ? '…' : ''}</div>
          </div>
          <button data-template-edit="${escapeHtml(t.id)}" type="button" aria-label="Edit ${escapeHtml(t.name)}" title="Edit"
            class="tlm-bgtranspar-ct-bd1pxsolid">Edit</button>
          <button data-template-delete="${escapeHtml(t.id)}" type="button" aria-label="Delete ${escapeHtml(t.name)}" title="Delete"
            class="tlm-bgtranspar-cfb7185-bd1pxsolid">Delete</button>
        </div>`;
      }).join('');
      const empty = `<div class="tlx-p22px-tacenter-cm">No templates yet${channel ? ` for ${channel.toUpperCase()}` : ''}. Click + Add below.</div>`;
      return all.length ? items : empty;
    }

    function renderEditor(template) {
      const isNew = !template;
      const t = template || { name: '', channel: channel || 'sms', subject: '', body: '' };
      const placeholders = '{firstName} · {lastName} · {fullName} · {greeting} · {address} · {portalUrl} · {repName} · {repPhone}';
      return `
        <div class="tlx-mt12px-p14px-bgs2">
          <h3 class="tlx-m0012px-fs14px-ct">${isNew ? 'New template' : 'Edit template'}</h3>
          <div class="tlx-dflex-gap8px-mb10px">
            <label class="tlx-fx1-fs11px-cm">
              Name
              <input id="nbd-tpl-name" type="text" value="${escapeHtml(t.name)}"
                class="tlm-dblock-wd100-mt4px">
            </label>
            <label class="tlx-fs11px-cm-w600">
              Channel
              <select id="nbd-tpl-channel"
                class="tlm-dblock-mt4px-p8px10px">
                <option value="sms" ${t.channel === 'sms' ? 'selected' : ''}>SMS</option>
                <option value="email" ${t.channel === 'email' ? 'selected' : ''}>Email</option>
              </select>
            </label>
          </div>
          <label id="nbd-tpl-subject-row" style="display:${t.channel === 'email' ? 'block' : 'none'}; margin-bottom:10px; font-size:11px; color:var(--m,#9aa3b2); font-weight:600;">
            Subject
            <input id="nbd-tpl-subject" type="text" value="${escapeHtml(t.subject || '')}"
              class="tlm-dblock-wd100-mt4px">
          </label>
          <label class="tlx-dblock-fs11px-cm">
            Body
            <textarea id="nbd-tpl-body" rows="6"
              class="tlm-dblock-wd100-mt4px-2">${escapeHtml(t.body || '')}</textarea>
          </label>
          <div class="tlx-fs10px-cm-mt6px">
            Tokens: ${escapeHtml(placeholders)}
          </div>
          <div class="tlx-dflex-gap6px-jcflexend">
            <button id="nbd-tpl-cancel" type="button" class="tlx-bgtranspar-cm-bd1pxsolid">Cancel</button>
            <button id="nbd-tpl-save" type="button" class="tlx-bglineargr-cfff-bdnone" data-template-id="${escapeHtml(t.id || '')}">Save</button>
          </div>
        </div>`;
    }

    let mode = 'list'; // 'list' | 'edit'
    let editingTemplate = null;

    function shell() {
      return `
        <div class="tlx-bgs-ct-bd1pxsolid">
          <div class="tlx-dflex-aicenter-gap10px">
            <span class="tlx-fs24px" aria-hidden="true">📝</span>
            <h2 id="nbd-templates-title" class="tlx-fs17px-m0">Message templates</h2>
            <button id="nbd-tpl-close-x" type="button" aria-label="Close"
              class="tlm-mlauto-bgtranspar-cm">×</button>
          </div>
          <p class="tlx-fs11px-cm-m0014px">
            Saved messages auto-fill the SMS / email composer when you share a portal link. Tokens like {firstName} and {portalUrl} get substituted before sending.
          </p>
          ${mode === 'edit' ? renderEditor(editingTemplate) : `
            <div id="nbd-tpl-list">${renderList()}</div>
            <div class="tlx-dflex-jcflexend-mt10px">
              <button id="nbd-tpl-add" type="button" class="tlx-bgtranspar-corange-bd1pxsolid">+ Add template</button>
            </div>
          `}
        </div>`;
    }

    function rerender() {
      overlay.innerHTML = shell();
      wire();
    }

    function wire() {
      const closeX = overlay.querySelector('#nbd-tpl-close-x');
      if (closeX) closeX.addEventListener('click', close);

      // List mode
      overlay.querySelectorAll('[data-template-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
          editingTemplate = get(btn.getAttribute('data-template-edit'));
          mode = 'edit';
          rerender();
        });
      });
      overlay.querySelectorAll('[data-template-delete]').forEach(btn => {
        // In PWA standalone mode native confirm() is replaced by a
        // toast that always answers yes (standalone-compat.js), so the
        // delete guard below would never stop anything on the phone.
        // nbdConfirm gives a real Promise<boolean> modal there; on
        // desktop it's undefined and we fall back to native confirm.
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-template-delete');
          const tpl = get(id);
          if (!tpl) return;
          const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
          if (!(await _ask(`Delete "${tpl.name}"?`))) return;
          remove(id);
          _toast('Template deleted', 'success');
          rerender();
        });
      });
      // W99: pin/unpin default per channel. Click the ⭐ to toggle.
      overlay.querySelectorAll('[data-template-pin]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-template-pin');
          const tpl = get(id);
          if (!tpl) return;
          if (tpl.isDefault) {
            // Unpin — clear default for this channel.
            setDefault(null, tpl.channel);
            _toast('Default cleared', 'info');
          } else {
            setDefault(id);
            _toast(`Default ${tpl.channel.toUpperCase()}: ${tpl.name}`, 'success');
          }
          rerender();
        });
      });
      const add = overlay.querySelector('#nbd-tpl-add');
      if (add) add.addEventListener('click', () => {
        editingTemplate = null;
        mode = 'edit';
        rerender();
      });

      // Edit mode
      const channelSel = overlay.querySelector('#nbd-tpl-channel');
      const subjectRow = overlay.querySelector('#nbd-tpl-subject-row');
      if (channelSel && subjectRow) {
        channelSel.addEventListener('change', () => {
          subjectRow.style.display = channelSel.value === 'email' ? 'block' : 'none';
        });
      }
      const cancelBtn = overlay.querySelector('#nbd-tpl-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', () => {
        mode = 'list';
        editingTemplate = null;
        rerender();
      });
      const saveBtn = overlay.querySelector('#nbd-tpl-save');
      if (saveBtn) saveBtn.addEventListener('click', () => {
        const id   = saveBtn.getAttribute('data-template-id') || '';
        const name = (overlay.querySelector('#nbd-tpl-name').value || '').trim();
        const ch   = overlay.querySelector('#nbd-tpl-channel').value;
        const subj = (overlay.querySelector('#nbd-tpl-subject')?.value || '').trim();
        const body = overlay.querySelector('#nbd-tpl-body').value || '';
        if (!name) { _toast('Name required', 'error'); return; }
        if (!body.trim()) { _toast('Body required', 'error'); return; }
        try {
          save({ id: id || undefined, name, channel: ch, subject: ch === 'email' ? subj : undefined, body });
          _toast('Template saved', 'success');
          mode = 'list';
          editingTemplate = null;
          rerender();
        } catch (e) {
          _toast('Save failed: ' + (e.message || 'unknown'), 'error');
        }
      });
    }

    function close() {
      _modalOpen = false;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);

    rerender();
    document.body.appendChild(overlay);
  }

  // ─── Init ────────────────────────────────────────────────────────
  seedDefaults();

  // ─── Pick + render (W98) ─────────────────────────────────────────
  // Quick picker modal for use from the send flow. Returns:
  //   { body, subject } if rep picked a template
  //   null              if rep clicked "Use default" (caller falls back)
  //   undefined         if rep cancelled, OR a picker/manager is
  //                     already open (caller aborts send)
  //
  // Picker is skipped automatically when there's exactly 1 template
  // for the channel — that template is applied directly. When 0
  // templates exist, returns null immediately so the caller falls
  // back to its hardcoded body.
  function pickAndRender(channel, ctx) {
    return new Promise((resolve) => {
      const templates = list(channel);
      if (templates.length === 0) {
        resolve(null);
        return;
      }
      if (templates.length === 1) {
        const rendered = apply(templates[0], ctx);
        resolve(rendered);
        return;
      }

      // W99: ⭐ default skips the picker. When the rep has flagged
      // one template as default for this channel, use it directly
      // — same zero-friction shape as the single-template path.
      // To force-open the picker for a one-off variation the rep
      // can pass `ctx.forceModal = true` (e.g. via shift-click on
      // the share button — wired in a future wave).
      const def = (ctx && ctx.forceModal) ? null : getDefault(channel);
      if (def) {
        resolve(apply(def, ctx));
        return;
      }

      // Multiple templates — open picker.
      if (_modalOpen) {
        // A picker (or the manager) is already on screen. FAIL CLOSED:
        // resolve undefined, which every caller treats exactly like
        // Cancel/Esc and aborts the send. This used to resolve
        // apply(templates[0]) — and smsForLead/emailForLead SEND
        // whatever this returns, with no review step after it. So a
        // second share tap landing while the first was still minting
        // its portal link texted templates[0] to the homeowner, unseen,
        // while the first picker was still up.
        _toast('Finish the open template picker first', 'info');
        resolve(undefined);
        return;
      }
      _modalOpen = true;

      const overlay = document.createElement('div');
      overlay.id = 'nbd-templates-picker-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'nbd-templates-picker-title');
      overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:var(--z-overlay,10000);
        display:flex; align-items:center; justify-content:center; padding:20px;
        font-family:'Barlow',-apple-system,system-ui,sans-serif;`;

      const channelLabel = channel === 'email' ? 'Email' : 'SMS';
      overlay.innerHTML = `
        <div class="tlx-bgs-ct-bd1pxsolid-2">
          <div class="tlx-dflex-aicenter-gap10px-2">
            <span class="tlx-fs22px" aria-hidden="true">${channel === 'email' ? '📧' : '💬'}</span>
            <h2 id="nbd-templates-picker-title" class="tlx-fs16px-m0">Pick ${escapeHtml(channelLabel)} template</h2>
            <button id="nbd-tpl-pick-close" type="button" aria-label="Cancel"
              class="tlm-mlauto-bgtranspar-cm">×</button>
          </div>
          <p class="tlx-fs11px-cm-m0012px">Tokens like {firstName} get filled in before the message opens.</p>
          <div id="nbd-tpl-pick-list" class="tlx-dflex-flecolumn-gap6px">
            ${templates.map((t, i) => `
              <button data-tpl-pick="${escapeHtml(t.id)}" type="button" class="tlm-taleft-p10px12px-r8px">
                <div class="tlx-mb4px">${escapeHtml(t.name)}${t._seeded ? ' <span class="tlx-fs10px-cm-w500">· default</span>' : ''}</div>
                <div class="tlx-fs11px-cm-w400">${escapeHtml((t.body || '').slice(0, 80))}${(t.body || '').length > 80 ? '…' : ''}</div>
              </button>
            `).join('')}
          </div>
          <div class="tlx-dflex-gap6px-jcspacebet">
            <button id="nbd-tpl-pick-default" type="button" class="tlx-bgtranspar-cm-bd1pxsolid-2">Use built-in default</button>
            <button id="nbd-tpl-pick-cancel" type="button" class="tlx-bgtranspar-cm-bd1pxsolid-2">Cancel</button>
          </div>
        </div>`;

      function close(result) {
        _modalOpen = false;
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(undefined);
      }

      overlay.querySelectorAll('[data-tpl-pick]').forEach(btn => {
        btn.addEventListener('click', () => {
          const t = get(btn.getAttribute('data-tpl-pick'));
          if (!t) { close(undefined); return; }
          close(apply(t, ctx));
        });
      });
      overlay.querySelector('#nbd-tpl-pick-default').addEventListener('click', () => close(null));
      overlay.querySelector('#nbd-tpl-pick-cancel').addEventListener('click', () => close(undefined));
      overlay.querySelector('#nbd-tpl-pick-close').addEventListener('click', () => close(undefined));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(undefined); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);

      // Initial focus on first template option.
      setTimeout(() => {
        const first = overlay.querySelector('[data-tpl-pick]');
        if (first) first.focus();
      }, 0);
    });
  }

  window.TemplatesLibrary = {
    __sentinel: 'nbd-templates-library-v1',
    list,
    get,
    save,
    remove,
    setDefault,    // W99
    getDefault,    // W99
    apply,
    pickAndRender,
    openManager,
  };
})();
