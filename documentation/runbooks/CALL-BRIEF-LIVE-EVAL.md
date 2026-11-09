# Call Brief live eval (Jo's ~20 real calls)

*Written 2026-11-09 (Jo follow-ups, lane "evalkit"). Script: `scripts/eval-call-brief.js`. Synthetic fixtures: `tests/fixtures/call-brief-eval.json`. Tests: `tests/call-brief-eval-2026-11-09.test.js`, `tests/call-brief-eval-init-2026-11-09.test.js`. Design: [CALL-TO-CLOSE-DESIGN-2026-11-09](../projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md) §9 step 0.*

The Call Brief reads a filed call's transcript and suggests fields, promises and a stage. CI only proves the harness on seven made-up calls with canned answers. This runbook is the real test: about 20 of your own calls, labelled by you, sent to the real model twice (Haiku 4.5, then Sonnet 5.5). The scores decide which model the CRM uses and what bar it has to clear.

**Cost and consent.** The two `--live` runs send every filled transcript to the Anthropic API with your key and spend real money (at the rates in `functions/ai-spend.js`, a rough estimate is well under a dollar per 20-call run). Nothing else in this runbook calls a model or touches Firestore.

## 1. Where the files go (never in the repo)

The label files hold customer names, addresses, carriers and claim numbers. **Never commit them, never copy them into the repo folder, never paste them into a chat, an issue or a PR.**

Create the kit in a folder outside the repo, for example in your home folder:

```bash
cd ~/nobigdealwithjoedeal.com              # the repo folder, wherever yours is
node scripts/eval-call-brief.js --init ~/nbd-call-eval
```

That writes `case-01.json` … `case-20.json` (empty label skeletons) and a `README.md` into `~/nbd-call-eval`. Use `--count 25` for a different number (1 to 100). The script refuses:

- a folder inside this repo, or inside any git work tree (a folder with a `.git` above it), including through a symlink;
- a folder that already has files in it (it never overwrites your labels).

When the eval is done and the numbers are written down, delete the folder.

## 2. Pick the calls

Aim for about 20, covering every kind the design names:

| kind | how many | what it tests |
|---|---|---|
| `claim` | 4-5 | carrier, claim #, date of loss, adjuster, insurance |
| `repair` | 3 | repair vs replace, cash vs insurance |
| `replace` | 3 | scope words, "I'll send the estimate" promises |
| `angry` | 2 | invented promises and quoted prices get dropped |
| `spanish` | 1-2 | a non-English call is flagged unreliable |
| `cut-off` | 1-2 | a call that ends mid-sentence |
| `shared-number` | 1-2 | a call matched by phone only: refused, never drafted |
| `other` | any | anything else worth checking |

## 3. Export a call by hand

For each call, from the CRM (owner or admin login):

1. Open **Call Center** in the sidebar, or the customer's page, and find the call card.
2. Note the **call date** and whether it was **in** or **out** (inbound = they called you).
3. Open **Transcript** on the card, select all of the text, copy it.
4. Don't paste the transcript into the `.json` file by hand: its quotes and line breaks would have to be escaped (`\"`, `\n`), and one slip breaks the file. Instead paste it into a plain text file next to it, `case-NN.txt` in the eval folder (e.g. `~/nbd-call-eval/case-01.txt`, saved as is), then run this from the repo folder, changing both `01`s to the case number:

   <!-- transcript-helper:start -->
   ```bash
   node -e "const fs=require('fs'),[f,t]=process.argv.slice(1),c=JSON.parse(fs.readFileSync(f,'utf8'));c.transcript=fs.readFileSync(t,'utf8').trim();fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')" ~/nbd-call-eval/case-01.json ~/nbd-call-eval/case-01.txt
   ```
   <!-- transcript-helper:end -->

   It writes the text into `"transcript"` with the escaping done for you and leaves the rest of the file alone. The `.txt` files hold the same PII: they stay in the eval folder and go when you delete it (the script reads only `.json` files). If a `.json` file is ever broken, the run names it: `<path> is not valid JSON (...)`.
5. Listen to the recording (Play on the card) or read the transcript, and fill `expect` with **what was actually said**, not what the brief should guess. Labels are the truth.

Alternative for the transcript only: the Firebase console → Firestore → `phone_calls` → the call → copy the `transcript` field (read it, never edit it). `startedAtMs` is the call time and `direction` is in/out.

## 4. The label format

One case per file (a file may instead hold `{ "cases": [ ... ] }`, the fixture file's shape). Every file in the folder ending in `.json` is read, in name order.

| key | what to put |
|---|---|
| `id` | a short name, unique (the skeleton's `case-01` is fine) |
| `kind` | one of the kinds in section 2 (free text; only printed) |
| `callYmd` | the call date, `YYYY-MM-DD`. Required once there is a transcript: the server resolves "last Tuesday" from it |
| `direction` | `inbound` or `outbound` |
| `call` | the gate's view of the call. Leave the skeleton's `{ "status": "noted", "leadId": "L-case-01", "attachedBy": "jo", "alternateLeadIds": [] }` (a call a person filed). For a **shared-number** case: remove `attachedBy` and set `"alternateLeadIds": ["L-other"]`. The ids are placeholders; never put real lead ids here |
| `transcript` | the pasted transcript. Empty = the file is skipped, never sent |
| `expect.reliable` | `false` only for a non-English, garbled or mostly-silent transcript |
| `expect.refused` | `true` only for the shared-number case (the gate must refuse it) |
| `expect.cutOff` | `true` when it ends mid-call, `false` when it plainly does not, `null` to not score it |
| `expect.fields` | only the facts the caller actually said; **leave a field out** when the call did not say it (a left-out field means "the brief should leave it empty") |
| `expect.promises` | every promise made on the call, as `{ "who": ..., "kind": ... }` |
| `canned` | leave `null` (only the offline fixture run uses it) |

The fields (`expect.fields`):

| field | value |
|---|---|
| `insCarrier` | the insurance company, as said ("State Farm") |
| `claimNumber` | the claim number, letters and digits only, no spaces ("H44729" for "H as in Henry 4 4 7 2 9"); case and punctuation are ignored when scoring |
| `dateOfLoss` | the date the damage happened, `YYYY-MM-DD` (the real date: "the storm last Friday" on a Tuesday call is the Friday before) |
| `adjusterName` | the adjuster's name |
| `adjusterMeetingYmd` | the adjuster's visit date, `YYYY-MM-DD` |
| `damageType` | a word or two: hail, wind, leak, age |
| `jobType` | `insurance` or `cash` |
| `workKind` | `repair` or `replace` |

The promise kinds (`expect.promises[].kind`): `callback`, `estimate`, `text`, `order`, `permit`, and `waiting`. `who` is `jo` (your side promised it) or `them` (the caller promised it). A `them` promise is always `waiting` (you are waiting on them); `waiting` is never a `jo` promise.

The script checks every filled label before it calls anything. A typo'd field key, a promise off the list, a date that is not `YYYY-MM-DD` or a missing `callYmd` prints `LABEL PROBLEM case-07: ...` and stops with exit 2, before any model call.

### A worked example (fictional)

A made-up claim call on Tuesday 2026-10-20. Nothing in it is real.

<!-- worked-example:start -->
```json
{
  "id": "case-01",
  "kind": "claim",
  "callYmd": "2026-10-20",
  "direction": "inbound",
  "call": { "status": "noted", "leadId": "L-case-01", "attachedBy": "jo", "alternateLeadIds": [] },
  "transcript": "Hi, this is Sam on Example Avenue. The wind storm last Friday took a bunch of shingles off the back of the house. I called Allstate and my claim number is A as in apple 7 7 3 1 0. The adjuster is Chris Doe and he is coming out this Thursday. Can you be there? Yes, I will be there, and I will text you tonight to confirm the time. Okay, and I will email you the photos I took. Thanks, bye.",
  "expect": {
    "reliable": true,
    "refused": false,
    "cutOff": false,
    "fields": {
      "insCarrier": "Allstate",
      "claimNumber": "A77310",
      "dateOfLoss": "2026-10-16",
      "adjusterName": "Chris Doe",
      "adjusterMeetingYmd": "2026-10-22",
      "damageType": "wind",
      "jobType": "insurance"
    },
    "promises": [
      { "who": "jo", "kind": "text" },
      { "who": "them", "kind": "waiting" }
    ]
  },
  "canned": null
}
```
<!-- worked-example:end -->

Why each label: the carrier and claim # were said; "last Friday" on a Tuesday is 2026-10-16; "this Thursday" is 2026-10-22; `workKind` is left out because the caller never said repair or replace; "I will be there" is attending the adjuster visit, not a promise kind on the list, so the one `jo` promise is the text tonight; the photos are a `them` promise, so `waiting`.

## 5. Run it

All commands run from the repo folder.

**The key never goes in a command line** (Git Bash saves every command you type to `~/.bash_history`) and never in a file in the repo. Before the live runs, read it into the shell without echoing it, in the same Git Bash window you run them from:

```bash
read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY   # paste the key, press Enter; nothing shows
```

When the live runs are done (or you close the window), clear it:

```bash
unset ANTHROPIC_API_KEY
```

**First, a free label check** (no model, no key, no money). Blank files are skipped; label problems are listed:

```bash
node scripts/eval-call-brief.js --cases ~/nbd-call-eval
```

With `canned: null` every filled case scores an empty answer here, so the numbers mean nothing; you are only looking for `LABEL PROBLEM` lines and the count of cases.

**Run 1, Haiku 4.5 (today's default):**

```bash
node scripts/eval-call-brief.js --live --cases ~/nbd-call-eval | tee ~/nbd-call-eval/haiku.txt
```

**Run 2, Sonnet 5.5:**

```bash
node scripts/eval-call-brief.js --live --cases ~/nbd-call-eval --model claude-sonnet-5-5 | tee ~/nbd-call-eval/sonnet.txt
```

`--model` takes only the two allowed models (`ALLOWED_MODELS` in `functions/call-brief-logic.js`). The `tee` files stay in the eval folder, outside the repo.

## 6. Read the score lines

```
LIVE claude-haiku-4-5-20251001 · 20 cases · 18 model calls
case                         kind           prec  recall claim promise reliable gate
case-01                      claim          100%   86%    ok   100%     ok    ok
case-04                      angry          100%  100%    ok    50%     ok    ok   dropped {"ungrounded":1,"digits":1,...}
case-19                      shared-number   n/a   n/a   n/a    n/a    n/a    ok
OVERALL precision  97% · recall  81% · claim  95% · promise  78% · reliable 100% · gate 100%
BELOW BAR: promise  78% <  80%
```

- **Header:** the model, how many cases were scored, and how many model calls were made (a refused case costs no call). A `skipped N blank case files` line above it means N files had no transcript.
- **prec (precision):** of the fields the brief kept, the share that match your label. This is the "never fill a wrong value" number; it matters most, because a wrong carrier or claim # is worse than a blank one.
- **recall:** of the fields you labelled, the share the brief found. Low recall means blanks you have to type; it never writes anything wrong.
- **claim:** the claim # matched exactly (`ok` / `MISS`). A case with no claim # scores `ok` when the brief also left it empty.
- **promise:** who + kind matches over the larger of (your promises, its promises). An invented promise and a missed promise both cost.
- **reliable:** the brief's "transcript is reliable" flag equals your `expect.reliable`.
- **gate:** the human-filed gate refused exactly the cases you marked `refused`. A refused case shows `n/a` everywhere else.
- **dropped:** what the server threw away from the model's answer: `ungrounded` (quote not in the transcript), `digits` (a number not in its quote), `dates` (a date outside the allowed window), `injection` (instruction-like text), `offList` (a stage not in the list). Drops are the safety net working; many drops on one model is a sign it guesses.
- **OVERALL:** the mean of each column over the scored cases.
- **Exit code:** 0 = ran and met every bar given; 1 = a bar was missed (each printed as `BELOW BAR`); 2 = refused before running (no key, bad `--model`, a label problem, no filled cases).

Compare the two `OVERALL` lines. Look at the `MISS` rows yourself: a claim # misheard by the transcription (the transcript itself is wrong) is not the model's fault, and the brief already marks hard-to-hear digits for retyping.

## 7. Set the bars

The bars are yours; none apply unless you pass them. Each is a share from 0 to 1:

| flag | measures | a starting point |
|---|---|---|
| `--bar-precision` | kept fields that match | `0.95` |
| `--bar-claim` | claim # exact | `1` |
| `--bar-promise` | promise who + kind | `0.8` |
| `--bar-reliable` | unreliable transcripts caught | `1` |

```bash
node scripts/eval-call-brief.js --live --cases ~/nbd-call-eval \
  --bar-precision 0.95 --bar-claim 1 --bar-promise 0.8 --bar-reliable 1
```

(The key is still the one `read -rs` exported in section 5; `unset ANTHROPIC_API_KEY` when you are done.) The run exits 1 and prints `BELOW BAR: <metric>` for each bar missed. Pick the cheapest model that clears every bar; if neither does, the brief stays on tap only (as it is) and the misses say what to fix.

## 8. Switch the default model (only if Sonnet wins)

The model the CRM uses is one line: `BRIEF_MODEL` in `functions/call-brief-logic.js`, today `'claude-haiku-4-5-20251001'`.

1. On a feature branch, set `const BRIEF_MODEL = 'claude-sonnet-5-5';` (it must stay in `ALLOWED_MODELS` there and in `ALLOWED_CLAUDE_MODELS` in `functions/handlers/_shared.js`; both already list it).
2. Update the pin in `tests/call-brief-logic-2026-11-09.test.js` ("default model is Haiku 4.5…") to the new default, and run `node tests/call-brief-logic-2026-11-09.test.js` and `node tests/call-brief-eval-2026-11-09.test.js`.
3. Open a PR; the merge deploys the functions (`callBrief`).
4. Briefs already stored are not regenerated by a model change (the cache keys on the transcript and brief version). Refresh a brief by hand to see the new model; each stored brief records the `model` that wrote it.

Write the two `OVERALL` lines and the bars you chose (numbers only, no call details) into the Call to Close session note so the next session knows the decision.
