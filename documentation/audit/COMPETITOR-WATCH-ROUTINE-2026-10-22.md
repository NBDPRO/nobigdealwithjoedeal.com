# Competitor and copycat watch: monthly routine (2026-10-22)

A repeatable, read-only look once a month. It extends what already runs:
[PUBLIC-REPO-COPY-POSTURE-2026-08-31](PUBLIC-REPO-COPY-POSTURE-2026-08-31.md) set the
baseline (0 forks, 0 stars, 0 watchers, no foreign repo carrying NBD fingerprints) and
`.github/workflows/copycat-watch.yml` re-checks it monthly and emails on a signal.
The earlier question was resolved as **inspired, not cloned**. This routine does not
reopen it.

## Ground rules

- Public pages only, read-only fetches. No sign-ups, no logins, no form submissions, no
  scraping behind a wall, no test leads, no contacting anyone.
- **Do not accuse anyone.** A similarity is an observation, not a finding of copying.
  Notes describe what is public and say "look-worthy", never "copied".
- **Outreach is out of scope.** Any contact, takedown or legal step is Jo's decision,
  made with counsel; the routine only records.
- No names, emails or other private identifiers of individuals in the public repo.
  Businesses are named only by their own public brand and URL.
- Record facts and dates, not adjectives.

## Step 1: confirm the existing watch (5 min)

`gh run list --workflow copycat-watch.yml --limit 3`. Green means the baseline holds. Red:
read the "Channel notes" section; infra noise (rate limits, code search blind) is not a
signal. A real signal is a new fork, star, watcher, or a fingerprint hit. Remember a
code-search zero proves nothing (GitHub did not index this repo).

## Step 2: look at the public web (20 min)

1. **Direct competitors' public pages**, a short fixed list kept in the monthly note
   (local roofers in Greater Cincinnati and Northern Kentucky; contractor-CRM products NBD
   Pro is compared with). Per site note, from public pages only:
   - Offer and pricing statements shown publicly; new service or town pages.
   - Claims worth comparing to NBD's honesty rules (licence, insurance, claim handling).
   - Review count and rating shown on the public profile.
   - New blog or guide topics.
2. **Fingerprint search by web search**, not the GitHub API: `Roofivent`,
   `nobigdeal-pro`, `NBD_ESTIMATE_CONFIG`, and two or three distinctive public phrases
   from the site. Note any result that is not an NBD domain.
3. **Look-alike check:** search the brand name plus "CRM" and "roofing software"; note any
   new site that reuses NBD wording, layout or assets verbatim. Describe it, do not judge it.

## Step 3: record it

Create `documentation/audit/COMPETITOR-WATCH-YYYY-MM.md` using this table, and link it
from `documentation/INDEX.md` in the same PR (`node scripts/check-vault-index.js`).

| Field | Content |
| --- | --- |
| Date, who ran it | |
| copycat-watch status | green/red, signals, infra notes |
| Fingerprint searches | term, any non-NBD hit, URL |
| Competitor changes | site, what changed, URL, date seen |
| Look-alikes | URL, what overlaps, evidence level |
| Worth Jo's attention | one to three lines |

Keep one dated note per month; correct earlier notes in place if later facts change.

## Step 4: escalation

Anything in "Worth Jo's attention" goes to Jo in the handoff. Only a verified, specific
overlap (identical text or asset on a third-party domain) is escalated, and then Jo decides
whether to involve counsel; the path would be a GitHub DMCA takedown for pushed clones
(the LICENSE grants no use). This routine takes no action beyond recording.

## Schedule

First Monday of the month, after the cron fire of `copycat-watch.yml`. Add a line to
`documentation/projects/WEEKLY_CADENCE.md` only if Jo wants it as a standing item.
