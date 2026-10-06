# NEXT SESSION — 2026-08-29

> **Superseded 2026-08-31.** The live brief is
> [NEXT_SESSION-2026-08-31](NEXT_SESSION-2026-08-31.md) (see the **Current
> handoff** pointer at the top of [INDEX](../INDEX.md)). This note is kept
> for the Cal.com lane it records — **§0 is still open**: Customer AF's
> backfill has not been run, and it is still the one command that needs Jo's
> prod credentials. §3's carried-forward items have moved on; trust 08-31
> over this note wherever they disagree.

Handoff from the Cal.com lead-drop session
([session note](SESSION-2026-08-28-calcom-lead-drop.md)) plus the still-open
lanes from [NEXT_SESSION-2026-08-28](NEXT_SESSION-2026-08-28.md). *(Updated
2026-08-31: 08-28 is now partly superseded — read only its §TRUE FINAL STATE
section, per INDEX; the rest are mid-session snapshots.)*

---

## §0 — THE LIVE ITEM: Customer AF's lead is still missing from the CRM

The bug is **fixed and deployed** (#1288) — every new Cal.com booking now
creates a Pipeline card on its own. The fix is **forward-only**, so the one
booking that exposed it still has no CRM record.

`scripts/backfill-calcom-dropped-leads.js` (merged in #1290, on `main`)
repairs it. **The run needs prod credentials, so it is Jo's**, and it is not
time-sensitive — the record repairs identically whenever it runs.

```bash
export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json

# DRY RUN — writes nothing without --apply --yes
node scripts/backfill-calcom-dropped-leads.js \
  --booking-uid=uLAU3nHLXBa4HQZnUHAYfK \
  --name="Customer AF" --email=[email removed] --phone=[phone removed] \
  --start=2026-08-29T14:00:00Z --duration=30 \
  --title="Free Roof Inspection" \
  --location="[street address], Wilder, KY, USA" \
  --organizer-username=nobigdeal
```

Target doc: `leads/calcom__uLAU3nHLXBa4HQZnUHAYfK`. The command was emailed
to Jo on 08-29 with the full `--notes` string.

Two properties worth not re-deriving (both emulator-verified):

- The lead id uses `L.bridgeDocId('calcom', <uid>)` — the **same** derivation
  the live webhook uses — so a later reschedule updates that card instead of
  creating a second one.
- An attendee already in the pipeline is **linked**, never duplicated (same
  email / last-10-phone rule as M-1). Safe to run even if Jo already added
  Kevin by hand.

To sweep for any other booking dropped in the same window (needs
`CALCOM_API_KEY`): `--from=2026-08-01 --to=2026-09-30`.

## §1 — The assertion that actually closes the Cal.com lane

**Fire one real booking** through `cal.com/nobigdeal/roof-inspection` and
confirm a Pipeline card appears with `source: "Website — Cal.com booking"`.

Nothing short of this closes the lane. The 08-26 "LIVE end-to-end" claim came
from two signature probes (unsigned POST → 400, signed PING → 200), and those
could not have caught a handler with no lead-creation path — the webhook
returned `200 {ok:true}` while dropping the booking. **Assert the outcome (a
card), not the precondition (a 200).** See §8 of the session note.

## §2 — Also open from the Cal.com lane

1. **GA4 / Search Console for the 08-28 session.** Until someone pulls it,
   §1's content-attribution read stays a hypothesis — it was NOT a geo-page
   win, and the note says so. Doing this once would also give the two
   rush-week national leads real attribution instead of a plausible one.
2. **Revoke the 08-25 Cal.com session API key** if it was created without an
   expiry — still carried, still unconfirmed.

## §3 — Carried forward, unchanged, from the 08-28 handoff

Read [NEXT_SESSION-2026-08-28](NEXT_SESSION-2026-08-28.md) for the detail;
these are the items still waiting:

- **GBP + Facebook posts remain HELD** on Jo's explicit instruction (twice).
  Nothing has been posted anywhere. Before the Lexington post goes up, add the
  six Central-KY towns to the GBP service area.
- **Two photo judgment calls** Jo hasn't answered: the Customer BR coating frame
  with an identifiable crew face, and the Customer BX "before" aerial that could
  not be confirmed as Rita's roof vs a neighbor's.
- **Two /our-work cards HELD:** Robert Wilson (needs a town — appears in no
  document) and By Golly's Bar & Grill (identifiable named business, Jo's
  courtesy call first).
- **The candidate pipeline** at
  [ourwork-candidate-pipeline-2026-08-28](../marketing/ourwork-candidate-pipeline-2026-08-28.md)
  is still the obvious content lane — Jo approved it, but the staging agents
  died on a session limit, so **nothing is staged**. Start fresh from the doc.

## §4 — Housekeeping done this session

`INDEX.md` carried **three** separate `- Session handoffs:` lines (in
*Projects & planning* twice, and a stray one inside *Audits*), each a
different-dated snapshot of the same running list, and **five** competing
"current — start here" claims across them. A session reading the wrong line
would have started from a 10-day-stale brief.

Consolidated to **one** list under *Projects & planning*, newest first. The
08-31 session independently added a **Current handoff** pointer at the top of
INDEX, which is now the single source of "which brief is live" — so the
consolidated list deliberately carries **no** start-here claim of its own and
defers to that pointer. All 37 links were preserved — the merge
was diffed link-by-link, and the six cost-lane notes that existed only on the
second line are still there. The stray line under *Audits* was fully
subsumed and is gone.

*(Added 2026-08-31, second pass — the findings above are now closed.)*

**The 49 invisible notes.** A reachability walk from INDEX (following relative
links to any depth, not just literal INDEX mentions) found **49 notes that
nothing could navigate to**: all of `archive/legacy/` plus companion docs in
ten QA campaign folders. The cause was a convention mismatch, not neglect —
each campaign's entry doc *is* linked from INDEX, but those entry docs named
their siblings as backticked filenames (`` `PROPOSALS.md` ``) rather than
relative links, which CLAUDE.md's "plain relative markdown links only" rule
already forbade. Fixed by giving each entry doc a **Companion docs in this
folder** section, labelled with each file's own H1. Vault is now 173/173
reachable.

Two things that surfaced only because those files became reachable:

- `archive/legacy/` carries **11 dangling links**, and some are *deliberate*:
  `GO_LIVE_CHECKLIST.md` says in its own header that its `docs/deploy/**`
  links are "retained for historical context" after those files were deleted
  (`firebase.json` sets `hosting.public: "docs"`, so anything under `docs/`
  would have been published). They are left alone; rewriting them would
  destroy the record.
- `README_MULTI_TENANT.md`'s `QUICK_START.md` link is a stale-path artifact of
  the move out of the repo root, not a deliberate one — also left as-is, being
  a frozen archive doc.

**Both findings are now CI-enforced** by `scripts/check-vault-index.js`:
exactly one `- Session handoffs` line, exactly one `**Current handoff:`
pointer, zero legacy "current — start here" markers, every note reachable from
INDEX, and no broken relative links (with `archive/` exempt from that last
check only, for the reason above). Mutation-tested against four separate
breakages — main's real three-line state, an added duplicate line, an unlinked
new note, and a dangling link — each fails it, so the gate asserts rather than
decorates.

**The rot pattern to avoid repeating:** each session prepended its note to a
copy of the line rather than editing the one list, so the old copies survived
with their stale start-here markers intact. Edit the list; don't add a line.
