#!/usr/bin/env node
/**
 * Agent `lead_sources` carries the owner's confirmed source (2026-10-22).
 * The intake tag is a hint; leads/{id}.confirmedSource is Jo's own answer
 * (docs/pro/js/lead-source-fixer.js). Counts only, no money, no names.
 * Run: node tests/lead-sources-confirmed-2026-10-22.test.js
 */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'functions/agent-mcp-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const NOW = Date.parse('2026-10-22T16:00:00Z');
const DAY = 86400000;
const iso = (n) => new Date(NOW - n * DAY).toISOString();
const lead = (id, o) => Object.assign({ id, name: 'Zed Person ' + id, createdAt: iso(5), stage: 'new', source: 'Website — Estimate' }, o);
const leads = [
  lead('a', { confirmedSource: 'yelp', stage: 'final_payment', stageRole: 'won' }), // intake says Website, owner says Yelp
  lead('b', { confirmedSource: 'yelp' }),
  lead('c', { confirmedSource: 'thumbtack_direct', source: 'Thumbtack' }),
  lead('d', {}),                                                    // no answer
  lead('e', { confirmedSource: 'made_up' }),                        // unknown value is not an answer
  lead('f', { confirmedSource: null }),                             // cleared (Undo)
  lead('g', { confirmedSource: 'yelp', createdAt: iso(400) }),      // outside the window
  lead('h', { confirmedSource: 'yelp', deleted: true }),            // deleted
];
const r = L.leadSources(leads, [], NOW, 90);
const by = (k) => (r.confirmed_sources || []).find((s) => s.source === k);

ok('positive: owner answer is counted even when intake said Website', by('yelp') && by('yelp').leads === 2, JSON.stringify(r.confirmed_sources));
ok('positive: won counts the sale test', by('yelp').won === 1, JSON.stringify(by('yelp')));
ok('positive: a Thumbtack direct answer has its own row', by('thumbtack_direct') && by('thumbtack_direct').leads === 1);
ok('negative: unknown value and cleared answer are not rows', !by('made_up') && !by(null) && r.confirmed_sources.length === 2);
ok('negative: no answer / unknown / cleared are unconfirmed (d, e, f)', r.unconfirmed_leads === 3, String(r.unconfirmed_leads));
ok('negative: outside the window and deleted leads are not counted', by('yelp').leads === 2);
ok('intake rows unchanged (still keyed by intake tag)', r.sources.some((s) => s.source === 'Website — Estimate') && r.sources.some((s) => s.source === 'Thumbtack'));
ok('no money fields and no customer names in the confirmed block', !/collected|spend|Zed/.test(JSON.stringify({ c: r.confirmed_sources })));
ok('note tells the reader the intake tag is a hint', /hint/.test(r.note) && /confirmed_sources/.test(r.note));
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
