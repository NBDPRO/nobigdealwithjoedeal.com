/**
 * lost-reason-picker.js — "Why was it lost?" is required (2026-10-04).
 *
 * Moving a lead (or one of a customer's jobs) to Lost now needs a quick-pick
 * reason: Price · Went with someone else · No damage · No response ·
 * Insurance denied · Other (+ a short note). The old sheet had a
 * "Skip — no reason" button, so losses could not be reported by reason; that
 * button is gone. Cancel still cancels the move.
 *
 *   NBDLostReason.prompt(lead, opts?) → Promise<{ key, note, fields } | false>
 *     opts.saveLabel: the save button's text (default 'Mark Lost'; the
 *     catch-up screen sets reasons on leads that are already lost).
 *     fields = { lostReasonKey, lostReason (label — note), lostReasonNote }
 *     false  = the user cancelled (the caller must NOT move the card)
 *
 * The rules (reason list, labels, "Other needs a note", the stored fields)
 * live in numbers-logic.js so Reports reads exactly what this writes.
 * A phone bottom sheet with big tap targets; CSP-safe (no inline handlers,
 * no style attributes — css/numbers.css).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDLostReason) return;

  function N() { return window.NBDNumbers; }

  function prompt(lead, opts) {
    return new Promise(function (resolve) {
      var Nn = N();
      if (!Nn) { resolve(false); return; }
      var old = document.getElementById('nbd-lost-reason-modal');
      if (old) old.remove();

      var bg = document.createElement('div');
      bg.id = 'nbd-lost-reason-modal';
      bg.className = 'nb-sheet-bg';
      bg.setAttribute('role', 'dialog');
      bg.setAttribute('aria-modal', 'true');
      bg.setAttribute('aria-labelledby', 'nbLostTitle');

      var sheet = document.createElement('div');
      sheet.className = 'nb-sheet';

      var h = document.createElement('div');
      h.className = 'nb-sheet-title';
      h.id = 'nbLostTitle';
      h.textContent = 'Why was it lost?';
      var sub = document.createElement('div');
      sub.className = 'nb-sheet-sub';
      var who = [lead && lead.firstName, lead && lead.lastName].filter(Boolean).join(' ') || (lead && (lead.name || lead.address)) || 'This customer';
      sub.textContent = who + ' — pick one. It feeds the losses report.';
      sheet.appendChild(h);
      sheet.appendChild(sub);

      var grid = document.createElement('div');
      grid.className = 'nb-reason-grid';
      var selected = null;
      Nn.LOST_REASONS.forEach(function (r) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'nb-reason';
        b.dataset.reason = r.key;
        b.setAttribute('aria-pressed', 'false');
        b.textContent = r.label;
        grid.appendChild(b);
      });
      sheet.appendChild(grid);

      var lbl = document.createElement('label');
      lbl.className = 'nb-note-label';
      lbl.htmlFor = 'nbLostNote';
      lbl.textContent = 'Note';
      var note = document.createElement('textarea');
      note.id = 'nbLostNote';
      note.className = 'nb-note';
      note.rows = 2;
      note.maxLength = 300;
      note.placeholder = 'Optional — required for Other';
      sheet.appendChild(lbl);
      sheet.appendChild(note);

      var err = document.createElement('div');
      err.className = 'nb-sheet-err';
      err.setAttribute('role', 'alert');
      sheet.appendChild(err);

      var foot = document.createElement('div');
      foot.className = 'nb-sheet-foot';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'nb-btn nb-btn-ghost';
      cancel.dataset.lr = 'cancel';
      cancel.textContent = 'Cancel';
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'nb-btn nb-btn-primary';
      save.dataset.lr = 'save';
      save.textContent = (opts && typeof opts.saveLabel === 'string' && opts.saveLabel) ? opts.saveLabel : 'Mark Lost';
      save.disabled = true;
      foot.appendChild(cancel);
      foot.appendChild(save);
      sheet.appendChild(foot);

      bg.appendChild(sheet);
      document.body.appendChild(bg);

      function refresh() {
        var e = Nn.validateLostReason({ key: selected, note: note.value });
        save.disabled = !!e;
        note.placeholder = selected === 'other' ? 'What happened? (required)' : 'Optional — required for Other';
        return e;
      }
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        bg.remove();
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); finish(false); } }
      document.addEventListener('keydown', onKey, true);

      grid.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-reason]') : null;
        if (!b) return;
        selected = b.dataset.reason;
        Array.prototype.forEach.call(grid.querySelectorAll('[data-reason]'), function (x) {
          var on = x === b;
          x.classList.toggle('nb-on', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        err.textContent = '';
        refresh();
        if (selected === 'other') note.focus();
      });
      note.addEventListener('input', function () { err.textContent = ''; refresh(); });
      foot.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-lr]') : null;
        if (!b) return;
        if (b.dataset.lr === 'cancel') { finish(false); return; }
        var problem = refresh();
        if (problem) { err.textContent = problem; return; }
        var choice = { key: selected, note: note.value.trim() };
        choice.fields = Nn.lostReasonFields(choice);
        finish(choice);
      });
      bg.addEventListener('click', function (e) { if (e.target === bg) finish(false); });
    });
  }

  window.NBDLostReason = { prompt: prompt };
})();
