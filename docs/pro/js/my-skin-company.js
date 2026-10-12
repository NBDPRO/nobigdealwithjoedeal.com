/**
 * my-skin-company.js — "Team backgrounds": a company admin's panel for the
 * company background set (My Skin spec section 18). Loaded lazily by
 * my-skin.js the first time an admin opens it; members never load it.
 *
 * What it writes:
 *   Storage   companies/{companyId}/skins/themes/{themeId|_all}/{imageId}[_t]
 *   Firestore companies/{companyId}/skin/config   (usage is the Cloud
 *             Function's alone; the rules refuse a client write to it)
 *
 * Each theme (or "every theme") carries up to 6 pictures, a mode
 * (suggested: members may override; enforced: they cannot) and a minimum dim.
 * The pictures are the company's to show its own team: before the first
 * upload the admin confirms the company owns or may use them, stored as
 * rightsAttestation { by, at, text: 'v1' }. They are private bucket objects
 * behind the rules, never public, never in the repo, never in customer
 * documents; members read them with getBlob() like any personal picture.
 *
 * Plain DOM building only (CSP, no innerHTML).
 */
(function () {
  'use strict';
  if (window.NBDMySkinCompany) return;

  var I = null, L = null, root = null;
  var busy = false;
  var target = '_all';
  var RIGHTS_TEXT = 'I confirm my company owns or has permission to use these images, and to show them to everyone on my team. NBD Pro stores them privately for this company and doesn’t review them.';

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0); }
  function themes() { try { return window.ThemeEngine.getAll(); } catch (e) { return {}; } }
  function nameOf(id) { return id === '_all' ? 'Every theme' : ((themes()[id] || {}).name || id); }
  function cfg() { return I.company() || L.normalizeCompany({}); }

  // dotted field paths → a nested object (for setDoc when the doc is new)
  function expand(patch) {
    var out = {};
    Object.keys(patch).forEach(function (k) {
      var parts = k.split('.'), o = out;
      for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
      o[parts[parts.length - 1]] = patch[k];
    });
    return out;
  }
  function write(patch) {
    return I.fsdk().then(function (f) {
      var ref = f.doc(window.db, 'companies', I.companyId(), 'skin', 'config');
      var p = Object.assign({ updatedAt: Date.now(), updatedBy: I.uid() }, patch);
      return f.updateDoc(ref, p).catch(function (e) {
        if (e && e.code === 'not-found') return f.setDoc(ref, expand(p), { merge: true });
        throw e;
      });
    });
  }
  function slotOf(id) { var c = cfg(); return id === '_all' ? c.all : c.themes[id]; }
  function fieldOf(id) { return id === '_all' ? 'all' : 'themes.' + id; }
  function plain(o) { return JSON.parse(JSON.stringify(o)); }

  function fail(msg) { I.toast(msg, 'warning'); }

  function setRights(on) {
    if (!on) return Promise.resolve();
    return write({ rightsAttestation: { by: I.uid(), at: Date.now(), text: 'v1' } });
  }

  // Add pictures (up to 6) to the target theme's set.
  function addFiles(files) {
    var c = cfg();
    if (!c.rightsAttestation) { fail('Confirm the rights statement first.'); return Promise.resolve(); }
    var tid = target;
    var existing = slotOf(tid);
    var room = L.MAX_IMAGES_PER_THEME - (existing ? existing.images.length : 0);
    if (room <= 0) { fail('Up to ' + L.MAX_IMAGES_PER_THEME + ' pictures per theme.'); return Promise.resolve(); }
    var list = Array.prototype.slice.call(files).slice(0, room);
    var incoming = list.reduce(function (n, f) { return n + f.size; }, 0);
    if (c.usage.bytes + incoming * L.STORED_RATIO_ESTIMATE > L.COMPANY_CAP_BYTES) {
      fail('Your company’s background storage is full (' + mb(L.COMPANY_CAP_BYTES) + ' MB).');
      return Promise.resolve();
    }
    busy = true; render();
    var added = [], pix = false;
    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () {
        var chk = L.checkInput(f);
        if (!chk.ok) { fail(chk.reason); return null; }
        return I.encode(f, L.THEME_IMAGE_SPEC, true, true).then(function (enc) {
          var id = L.mintImageId();
          var path = L.companyStoragePath(I.companyId(), tid, id);
          if (!path) throw new Error('path');
          return I.sdk().then(function (st) {
            return st.uploadBytes(st.ref(window.storage, path), enc.blob, { contentType: enc.blob.type, cacheControl: 'private, max-age=0' })
              .then(function () {
                if (!enc.thumb) return false;
                return st.uploadBytes(st.ref(window.storage, path + '_t'), enc.thumb, { contentType: enc.thumb.type, cacheControl: 'private, max-age=0' })
                  .then(function () { return true; }, function () { return false; });
              });
          }).then(function (hasThumb) {
            var s = enc.stats || {};
            pix = pix || Math.max(enc.srcW || 0, enc.srcH || 0) <= 640;
            added.push({ id: id, path: path, v: Date.now(), w: enc.w, h: enc.h, lum: s.lum != null ? s.lum : null,
              lumCenter: s.lumCenter != null ? s.lumCenter : null, avg: s.avg || null, accent: s.accent || null, type: enc.blob.type, bytes: enc.blob.size, thumb: hasThumb });
          });
        }).catch(function (e) {
          fail(e && e.message === 'too-big' ? 'That picture is too detailed to store.' : e && e.message === 'decode' ? 'Couldn’t open that picture.' : 'Upload failed. Check your connection.');
        });
      });
    });
    return chain.then(function () {
      if (!added.length) return null;
      var base = existing ? plain(existing) : { mode: 'suggested', minDim: null, dim: null, blur: 0, position: 'center', fit: 'cover', pixelated: pix };
      base.images = (existing ? existing.images : []).concat(added).slice(0, L.MAX_IMAGES_PER_THEME);
      base.updatedAt = Date.now();
      var p = {}; p[fieldOf(tid)] = base;
      return write(p).then(function () { I.toast(added.length + ' picture' + (added.length === 1 ? '' : 's') + ' added for ' + nameOf(tid) + '. Your team sees them.', 'success'); });
    }).catch(function () { fail('Couldn’t save. Check your connection and try again.'); })
      .then(function () { busy = false; render(); });
  }

  function patchSlot(tid, fn) {
    var s = slotOf(tid);
    if (!s) return Promise.resolve();
    var c = plain(s); fn(c); c.updatedAt = Date.now();
    var p = {}; p[fieldOf(tid)] = c;
    return write(p).catch(function () { fail('Couldn’t save. Check your connection.'); }).then(render);
  }

  function removePicture(tid, imageId) {
    var s = slotOf(tid);
    if (!s) return Promise.resolve();
    var gone = s.images.filter(function (i) { return i.id === imageId; });
    var left = s.images.filter(function (i) { return i.id !== imageId; });
    var p = {};
    if (left.length) { var c = plain(s); c.images = left; c.updatedAt = Date.now(); p[fieldOf(tid)] = c; }
    else {
      return I.fsdk().then(function (f) { p[fieldOf(tid)] = f.deleteField(); return write(p); }).then(function () { return delObjects(gone); }).then(render);
    }
    return write(p).then(function () { return delObjects(gone); }).catch(function () { fail('Couldn’t remove that. Try again.'); }).then(render);
  }
  function delObjects(imgs) {
    return I.sdk().then(function (st) {
      return Promise.all(imgs.map(function (im) {
        var p = L.trustedCompanyImagePath(I.companyId(), im);
        if (!p) return null;
        var jobs = [st.deleteObject(st.ref(window.storage, p)).catch(function () {})];
        if (im.thumb) jobs.push(st.deleteObject(st.ref(window.storage, p + '_t')).catch(function () {}));
        return Promise.all(jobs);
      }));
    }).catch(function () {});
  }
  function removeSet(tid) {
    var s = slotOf(tid);
    if (!s) return Promise.resolve();
    return I.fsdk().then(function (f) { var p = {}; p[fieldOf(tid)] = f.deleteField(); return write(p); })
      .then(function () { return delObjects(s.images); }).then(render);
  }

  function render() {
    if (!root || !root.isConnected) return;
    var c = cfg();
    clear(root);
    var kids = [];
    kids.push(h('div', { class: 'myskin-slot-title', text: 'Team backgrounds' }));
    kids.push(h('p', { class: 'myskin-note', text: 'Pick a background for each theme, or one for every theme, and your whole team sees it. Suggested ones can be changed by each person; enforced ones cannot. Company backgrounds are seen by your whole team: don’t upload customer photos, personal information, or art you don’t have rights to.' }));
    // master switches
    kids.push(h('label', { class: 'myskin-row' }, [h('span', { text: 'Show these backgrounds to my team' }), h('input', { type: 'checkbox', 'data-co': 'enabled', checked: c.enabled })]));
    kids.push(h('label', { class: 'myskin-row' }, [h('span', { text: 'Let people turn company backgrounds off (suggested ones only)' }), h('input', { type: 'checkbox', 'data-co': 'allowHide', checked: c.allowHide })]));
    kids.push(h('label', { class: 'myskin-row' }, [h('span', { text: 'Preview as a team member (hides my own skin)' }), h('input', { type: 'checkbox', 'data-co': 'preview' })]));
    // rights
    if (!c.rightsAttestation) {
      kids.push(h('label', { class: 'myskin-row myskin-rights' }, [h('span', { text: RIGHTS_TEXT }), h('input', { type: 'checkbox', 'data-co': 'rights' })]));
    } else {
      kids.push(h('p', { class: 'myskin-note', text: 'Rights confirmed ' + new Date(c.rightsAttestation.at).toLocaleDateString() + '.' }));
    }
    // usage
    var pct = Math.min(100, Math.round(c.usage.bytes / L.COMPANY_CAP_BYTES * 100));
    kids.push(h('div', { class: 'myskin-usage' }, [
      h('progress', { max: '100', value: String(pct), 'aria-label': 'Team background storage used' }),
      h('span', { class: 'myskin-slot-help', text: mb(c.usage.bytes) + ' MB of ' + mb(L.COMPANY_CAP_BYTES) + ' MB used' + (c.usage.rejectedAt ? ' · a picture was refused for space' : '') }),
    ]));
    // add
    var sel = h('select', { class: 'btn btn-ghost btn-sm myskin-select', 'data-co': 'target', 'aria-label': 'Theme' });
    sel.appendChild(h('option', { value: '_all', text: 'Every theme' }));
    var t = themes();
    Object.keys(t).forEach(function (id) { if (!t[id].locked) sel.appendChild(h('option', { value: id, text: t[id].name })); });
    sel.value = target;
    var pick = h('input', { type: 'file', class: 'myskin-file', accept: 'image/*', multiple: true, 'data-co': 'files', disabled: busy || !c.rightsAttestation });
    kids.push(h('div', { class: 'myskin-actions' }, [
      sel,
      h('label', { class: 'btn btn-ghost btn-sm myskin-btn myskin-pick' }, ['Add pictures', pick]),
      h('span', { class: 'myskin-status', 'aria-live': 'polite', text: busy ? 'Working…' : '' }),
    ]));
    // sets
    var ids = Object.keys(c.themes).sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
    if (c.all) ids.unshift('_all');
    ids.forEach(function (id) {
      var s = id === '_all' ? c.all : c.themes[id];
      var row = h('div', { class: 'myskin-coset', 'data-co-set': id }, [
        h('div', { class: 'myskin-slot-title', text: nameOf(id) + ' · ' + s.images.length + (s.images.length === 1 ? ' picture' : ' pictures') }),
      ]);
      var mode = h('select', { class: 'btn btn-ghost btn-sm myskin-select', 'data-co-mode': id, 'aria-label': 'Mode for ' + nameOf(id) }, [
        h('option', { value: 'suggested', text: 'Suggested' }), h('option', { value: 'enforced', text: 'Enforced' })]);
      mode.value = s.mode;
      var min = h('input', { type: 'number', min: '0', max: '85', step: '5', class: 'myskin-num', 'data-co-mindim': id, value: String(Math.round((s.minDim || 0) * 100)), 'aria-label': 'Minimum dim for ' + nameOf(id) });
      row.appendChild(h('div', { class: 'myskin-actions' }, [mode, h('label', { class: 'myskin-slot-help' }, ['Min dim % ', min]),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-co-removeset': id, text: 'Remove this set' })]));
      var strip = h('div', { class: 'myskin-actions' });
      s.images.forEach(function (im, i) {
        strip.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-co-remove': id + '/' + im.id, 'aria-label': 'Remove picture ' + (i + 1) + ' of ' + nameOf(id), text: 'Remove ' + (i + 1) }));
      });
      row.appendChild(strip);
      root.appendChild(row);
    });
    var head = h('div', { class: 'myskin-coadmin' }, kids);
    root.insertBefore(head, root.firstChild);
    var prev = head.querySelector('[data-co="preview"]'); if (prev) prev.checked = !!root.__preview;
  }

  function wire() {
    if (root.__coWired) return;
    root.__coWired = true;
    root.addEventListener('change', function (e) {
      var t = e.target, d = t.getAttribute && t.getAttribute('data-co');
      if (d === 'enabled') write({ enabled: !!t.checked }).catch(function () { fail('Couldn’t save.'); });
      else if (d === 'allowHide') write({ allowHide: !!t.checked }).catch(function () { fail('Couldn’t save.'); });
      else if (d === 'preview') { root.__preview = !!t.checked; I.setPreviewAsMember(root.__preview); }
      else if (d === 'rights') setRights(!!t.checked).catch(function () { fail('Couldn’t save.'); });
      else if (d === 'target') { target = t.value; }
      else if (d === 'files') { var fs = Array.prototype.slice.call(t.files || []); t.value = ''; if (fs.length) addFiles(fs); }
      else if (t.hasAttribute && t.hasAttribute('data-co-mode')) {
        var m = t.value === 'enforced' ? 'enforced' : 'suggested';
        patchSlot(t.getAttribute('data-co-mode'), function (s) { s.mode = m; });
      } else if (t.hasAttribute && t.hasAttribute('data-co-mindim')) {
        var v = Math.max(0, Math.min(85, Number(t.value) || 0)) / 100;
        patchSlot(t.getAttribute('data-co-mindim'), function (s) { s.minDim = v || null; });
      }
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-co-remove],[data-co-removeset]');
      if (!b) return;
      if (b.hasAttribute('data-co-remove')) {
        var parts = b.getAttribute('data-co-remove').split('/');
        removePicture(parts[0], parts[1]);
      } else {
        if (b.getAttribute('data-armed') !== '1') { b.setAttribute('data-armed', '1'); b.textContent = 'Tap again to remove'; return; }
        removeSet(b.getAttribute('data-co-removeset'));
      }
    });
  }

  window.NBDMySkinCompany = {
    __v: 1,
    open: function (el, internals) {
      I = internals; L = internals.L; root = el;
      el.hidden = false;
      wire();
      render();
    },
    // my-skin.js calls this when the company doc changes (our own writes,
    // another admin): redraw the panel if it is open.
    refresh: function () { render(); },
  };
})();
