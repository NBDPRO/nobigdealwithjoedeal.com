#!/usr/bin/env node
/**
 * scripts/copycat-foreign-repos.js — which search hits belong to SOMEONE
 * ELSE (copycat-watch.yml, roadmap step 13, 2026-11-25).
 *
 * The watch compared hits against a hard-coded full name. When the repo
 * moved to a new org, its own new full name stopped matching that string,
 * so the monthly run flagged our own repo as a copy. "Own" is now the
 * running repo's OWNER (github.repository), read at run time: any repo of
 * that owner or org is ours and never a signal.
 *
 *   node scripts/copycat-foreign-repos.js --self <owner/repo> [--allow <regex>] <full_name>...
 *       prints each foreign full_name, one per line (names may also arrive
 *       space-separated inside one argument, as an unquoted $HITS does).
 *   node scripts/copycat-foreign-repos.js --self <owner/repo> --dry-run
 *       proves the running repo itself is not a match: exit 1 if it would be.
 *
 * Zero deps.
 */
'use strict';

const ownerOf = (full) => String(full || '').split('/')[0].toLowerCase();

/** names: full_names from a search; opts: { self: 'owner/repo', allow?: regex source }. */
function foreignRepos(names, opts) {
  const self = String((opts && opts.self) || '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(self)) throw new Error('--self must be owner/repo, got ' + JSON.stringify(self));
  const allow = opts.allow ? new RegExp(opts.allow) : null;
  const own = ownerOf(self);
  return (names || [])
    .map((n) => String(n || '').trim())
    .filter((n) => n && ownerOf(n) !== own && !(allow && allow.test(n)));
}

function main(argv) {
  let self = '', allow = '', dry = false;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self') self = argv[++i] || '';
    else if (a === '--allow') allow = argv[++i] || '';
    else if (a === '--dry-run') dry = true;
    else names.push(...String(a).split(/\s+/));
  }
  if (dry) {
    // Our own repo, its case-folded twin and a sibling in the same org must
    // all be "ours"; a stranger's copy must still be foreign (positive control).
    const owner = self.split('/')[0];
    const ownHits = foreignRepos([self, self.toUpperCase(), owner + '/another-repo'], { self, allow });
    const control = foreignRepos(['someone-else/' + (self.split('/')[1] || 'x')], { self, allow });
    if (ownHits.length || control.length !== 1) {
      console.error('copycat filter is wrong: own=' + JSON.stringify(ownHits) + ' control=' + JSON.stringify(control));
      return 1;
    }
    console.log('copycat filter ok: ' + self + ' and its org are not a match; a foreign copy still is.');
    return 0;
  }
  for (const n of foreignRepos(names, { self, allow })) console.log(n);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exitCode = 2; }
}

module.exports = { foreignRepos, main };
