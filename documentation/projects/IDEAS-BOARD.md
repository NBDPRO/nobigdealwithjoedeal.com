# Ideas board

Jo throws ideas (bots, agents, automation, tools, anything); Claude triages each one and keeps the verdict here so nothing is lost between
sessions. Newest first. Started 2026-10-22.

**Verdicts:** *Covered* (we already have it, with where), *Good fit* (worth building, with the smallest first step), *Maybe* (needs a
decision or more facts), *Park* (not now, with why), *No* (a rule or a risk says no). A verdict is a recommendation; Jo decides.

**Standing limits that decide a lot of these:** nothing is sent to customers or third parties automatically (drafts only); no credentials
or secrets in any tool; no pricing, contract, legal or insurance-claim wording without the gate; private files stay out of third-party
tools; new tools that read session transcripts or the repo are a privacy question first.

| Date | Idea (source) | Verdict | Why and the smallest next step |
|---|---|---|---|
| 2026-10-22 | **Persistent memory add-on for coding agents** (a pre-launch tool called Sigillion, from a Facebook post) | Park | We already keep memory files, a vault, and a single handoff note per session. The tool is pre-launch, the quoted accuracy numbers are the author's own tests, and it would capture session transcripts, which touch private files. Revisit when it is released and independently reviewed; first step then would be a read-only look at what it stores and where. |
| 2026-10-22 | **A big multi-agent home lab with a study, test, grade, reflect, validate, improve loop** (a Facebook post, 49 agents on local hardware) | Maybe (steal the loop, skip the scale) | The claims (10x, under $100 a month) are unverified. The useful idea is the loop. The office-bot team already runs hourly routines with draft-only output; the cheap version is a weekly "what did each bot get wrong, what do we change" note per bot, written for Jo to read. |
| 2026-10-22 | **Switchable Daily Success layouts, gamified modes, boss fights, seasons** (Jo plus Grok) | Good fit (in progress) | Plan and order in [DAILY-SUCCESS-INTERFACES-2026-10-22](DAILY-SUCCESS-INTERFACES-2026-10-22.md). Layout switch is live; Log Book and Rings are next. |
| 2026-10-22 | **Blog post about waiting in line at the paint counter** (Jo) | Good fit (draft waiting on Jo) | Draft is in `documentation/drafts/` (see the drafts README); needs Jo's own lines and a read of the tips. |

## How an idea gets added

Jo says it in chat (or sends a screenshot). Claude adds a row with a verdict and the reason, says it in one or two lines, and does not
build anything that is not marked *Good fit* and approved. Rows that become real work link to their plan note; finished ones stay for
the record.
