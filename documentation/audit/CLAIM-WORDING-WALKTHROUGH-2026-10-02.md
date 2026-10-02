# Claim wording: the "walk you through the claim" family (2026-10-02)

The 2026-09-27 gate (`tests/claim-wording.test.js`, KRS 367.628 / ORC 3951)
caught every sentence where Joe *handles / negotiates / files* the claim. It
missed sentences that say the same thing **without** a handle-the-claim verb.
I found them while checking Thursday's phone prompt for the Ask Joe rules lane
(jdealtia-sys/nobigdealwithjoedeal.com#1991, audit note
ASK-JOE-GROUND-RULES-2026-10-02).

## What was live on the public site

| Phrase | Where | Why it crosses the line |
|---|---|---|
| "You focus on your deductible; **we handle the rest**." | **Homepage FAQ** (visible + JSON-LD) + llms-full.txt | everything but the deductible = the claim (367.628(1)(a)1) |
| "walk you through the (entire) claim process (from filing through adjuster meeting and final payment)" | hail pages: Batavia, Cincinnati, Clarksville, Loveland, Mason; storm Mt Orab; /areas/miamisburg | claim guidance as a service. The gate already banned "claim guidance" (`claim-assistance`); this is the same thing in other words |
| "getting Batavia homeowners through the claim process" | storm-damage-batavia | same |
| "I … can **request a re-inspection** … that changes the outcome" | hail-damage-batavia | the contractor acting with the carrier for the insured |
| "I **stay involved** through adjuster visits … make sure the final scope reflects …" | 6 hail pages | claim involvement as a service |
| "someone who **knows the insurance side**" | hail-damage-clarksville | markets insurance expertise ((1)(a)2) |
| "You shouldn't have to figure this out alone" / "that's what I'm here for" | Cincinnati, Mason (beside the walk-through) | implies carrying the claim |

All of these are reworded to the vocabulary the gate already uses: *you file
the claim with your carrier; once you have, I meet the adjuster on the roof*;
*a supplement (my updated estimate) for anything the first scope missed*;
*the claim is yours to file and decide*. Jo's 2026-09-27 standing decision,
"reword everywhere … not close to crossing any lines", covers it, so no new
question was asked.

**Left alone on purpose:** advice the homeowner acts on ("**you** can request
a re-inspection in writing", "hire a public adjuster"), and explaining a
decision ("walk you through *whether* a claim makes sense", "*what* a claim
looks like").

`docs/llms-full.txt`: only the two homepage sentences were patched by hand.
A full `--write-full` rewrites ~1,400 lines because the committed seed lags,
and deploy regenerates it anyway.

## The gate now catches them

Six rules were added: `walk-through-claim`, `through-the-claim`,
`handle-the-rest` (near a claim, insurance or deductible word),
`contractor-reinspection`, `stay-involved` and `insurance-side`.
- Each one is proven red against the live sentence it was written for.
- The new GOOD fixtures pass: "walk you through whether a claim makes
  sense", "you can request a reinspection in writing", "once you get through
  the claim, the build takes a day", and "handle the rest of the build".
- Its first run against the tree found four sentences the manual sweep
  missed: a Cincinnati variant ("I stay involved through the adjuster visit
  …") and the two llms-full.txt copies.

## Not fixed here: Thursday (Jo's call)

Thursday's live Bland prompt (agent `4c2b2b93…`, production 0.6.2, read
2026-10-02, read-only) answers "Do you work with insurance?" with:

> Joe has seven-plus years in insurance restoration, documents everything,
> **and can walk them through the claim.** Never say whether it'll be covered.

That is the same phrase this PR removes from the site. Her prompt has no
deposit or price quoting ("never quote prices"), and no AOB or "we handle it"
wording.

Changing Thursday means a new agent version: builder or
`scripts/thursday-agent-lookup.js` → staging → a Jo test call → promote. So it
waits for Jo. Suggested line: *"Yes. Joe documents the damage, writes the
estimate, and meets the adjuster on the roof after you file. The claim stays
yours. Never say whether it'll be covered."*
