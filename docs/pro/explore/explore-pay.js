// explore-pay.js — fills in the sample pay link page (Pro demo phase 2,
// wave 4, 2026-10-07): the invoice and amount from its own query string,
// shown as text. Nothing is fetched or submitted.
(function () {
  'use strict';
  var q;
  try { q = new URLSearchParams(location.search); } catch (_) { return; }
  var amount = Number(q.get('amount'));
  var invoice = String(q.get('invoice') || '').replace(/[^\w-]/g, '').slice(0, 40);
  var a = document.getElementById('xp-amount');
  var i = document.getElementById('xp-invoice');
  if (a && isFinite(amount) && amount > 0) {
    a.textContent = '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' (sample)';
  }
  if (i && invoice) i.textContent = invoice + ' (sample)';
})();
