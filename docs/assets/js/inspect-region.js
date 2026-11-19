/**
 * inspect-region.js: which Cal.com inspection event /inspect should open.
 * Lexington / Central KY has its own schedule (trips are batched onto set
 * days), so a Central KY lead must not see Cincinnati slots. Everyone else
 * keeps the Cincinnati event, which is also what a miss falls back to.
 *
 * Two signals, positive matches only:
 *   1. The visitor came from a Central KY area or service page (same-site referrer).
 *   2. The address says so: a Central KY ZIP, or a Central KY town followed by KY.
 * Classic script, no inline handlers (CSP); window.NBDInspectRegion, and
 * module.exports for the node test.
 */
(function (root) {
  'use strict';
  var CINCY = 'https://cal.com/nobigdeal/roof-inspection';
  var LEX = 'https://cal.com/nobigdeal/roof-inspection-lexington';
  // Lexington 405xx, Nicholasville 40356, Richmond 40475/40476, Winchester 40391,
  // Versailles 40383, Georgetown KY 40324.
  var ZIP = /(?:^|[^\d])(405\d\d|40356|40475|40476|40391|40383|40324)(?:-\d{4})?\s*$/;
  // City names repeat in Ohio (Georgetown, Winchester, Richmond), so require KY.
  var TOWN = /\b(lexington|nicholasville|richmond|winchester|versailles|georgetown)\b[\s,.]+(?:ky|kentucky)\b/i;
  var PAGE = /\/(?:areas|services)\/[a-z0-9-]*?(?:lexington|nicholasville|richmond|winchester|versailles|georgetown)-ky(?:\.html)?(?:[/?#]|$)/i;

  function addressIsCentralKy(address) {
    var a = String(address == null ? '' : address).trim();
    return ZIP.test(a) || TOWN.test(a);
  }
  function referrerIsCentralKy(ref) {
    var r = String(ref == null ? '' : ref);
    var m = r.match(/^https?:\/\/[^/]+(\/.*)?$/i);
    return !!(m && m[1] && PAGE.test(m[1]));
  }
  function calendarBase(address, ref) {
    return (addressIsCentralKy(address) || referrerIsCentralKy(ref)) ? LEX : CINCY;
  }
  var api = { calendarBase: calendarBase, addressIsCentralKy: addressIsCentralKy, referrerIsCentralKy: referrerIsCentralKy, LEX: LEX, CINCY: CINCY };
  root.NBDInspectRegion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
