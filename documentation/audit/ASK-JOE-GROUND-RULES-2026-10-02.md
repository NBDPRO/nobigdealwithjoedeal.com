# Ask Joe ground rules + golden answer checks (2026-10-02)

This was the handoff's top lane (part 3, §4.2): "Ask Joe / Thursday answer
checks. A small golden-question set for Kentucky claim wording and the
deposit rule. Nothing catches drift today."

## What a read of origin/main found

- **CRM Ask Joe** (`docs/pro/js/ai.js` `buildJoeSystemPrompt`, Haiku 4.5) had
  the claim-ownership and no-AOB rule. It had **no** Kentucky
  payment-timing rule (KRS 367.626), **no** $100 rule (367.628(2)) and **no
  deposit rule**. Asked "how much down on a $5,000 cash job?", it could only
  improvise.
- **The standalone `/pro/ask-joe` page** (`js/pages/ask-joe-main.js`) is live
  and linked from the tools page. It had its own one-line prompt claiming
  Joe knew **"adjuster negotiations"**, with none of the rules.
- **The AI proxy** (`functions/handlers/ai.js`) cut every system prompt at
  **4000 chars**. With the full rules, the CRM prompt is 4186 chars, so its
  end would have been silently dropped. A busy member's context makes it
  longer still.
- **Thursday's spoken script** lives on Bland (pathway
  `771a3ea4-1e79-40da-aafa-6ec086688913`), not in the repo. It is **not
  covered** here; checking it needs a Bland pathway export.

## What changed

- **`docs/pro/js/ask-joe-rules.js`** is the one set of ground rules, loaded by
  both surfaces:
  - the claim belongs to the homeowner;
  - no negotiating, AOB, direction-to-pay, deductible waivers, or "we
    handle your claim";
  - Kentucky insurance jobs: nothing due at signing until the insurer's
    written decision plus 5 business days (367.626; emergency work billable
    separately);
  - no rebates, no discounts, nothing over $100, and no "claims
    specialist" (367.628);
  - **the deposit rule, quoted from `deposit-rule.js` `policyText()`**, so
    changing the config changes Ask Joe's answer;
  - "if unsure about OH/KY legality, say so".
- **`ai.js`** builds its ground rules from that file. If the file fails to
  load, a minimal claim + KY-payment floor still goes in (fail closed).
- **`/pro/ask-joe`** loads `deposit-rule.js` and `ask-joe-rules.js`, and its
  persona line now says "meeting adjusters on the roof" instead of
  "adjuster negotiations".
- **AI proxy:** the system cap is now a named `CLAUDE_MAX_SYSTEM_CHARS =
  12000`. Tokens are still metered by the daily budget.

## Checks

**`tests/claim-wording.test.js` §5** now **builds the real prompts** in a vm
(deposit-rule + rules + `ai.js`'s functions, and the standalone page's
expression) and tests the strings a model would receive:
- claim ownership, the KY statute and the OH public-adjuster rule;
- no negotiate / AOB / direction-to-pay / deductible waiver;
- KY nothing at signing;
- KY over-$100 and "claims specialist";
- the deposit rule's numbers;
- member numbers come only from the context;
- the deposit line follows the config (40% in, "40%" out);
- with the rules file missing, the legal floor still goes in;
- script load order on both pages;
- a heavy member context stays under the cap.

Break-tested: dropping the KY payment rule turns both surfaces red.

**Golden answers.** `scripts/eval-ask-joe-logic.js` holds 8 questions and a
grader:
- will you handle my claim;
- assignment of benefits;
- covering the deductible;
- $5,000 cash deposit;
- $1,500 cash deposit;
- KY deductible at signing;
- KY $250 gift card;
- "Insurance Claims Specialist" on the truck.

Each has must / never patterns. §5 proves the grader **fails** "we'll handle
your claim … negotiate", an improvised ⅓ deposit and "collect the
deductible at signing like normal", and passes the lawful answers.

`scripts/eval-ask-joe.mjs` asks the **real model** those questions with the
real prompt (CRM, or `--standalone`) and exits 1 on any rule break:

```
ANTHROPIC_API_KEY=… node scripts/eval-ask-joe.mjs
ANTHROPIC_API_KEY=… node scripts/eval-ask-joe.mjs --standalone
```

It is not in CI, because CI holds no Anthropic key. Run it after any change
to the rules, the prompt or the model. **It has not been run yet:** no key
was available in this session.

## Update 2026-10-02 (later): first live run, all lawful, and the grader fixed

The key comes from Secret Manager (the same `ANTHROPIC_API_KEY` the AI proxy
binds), so no repo secret was needed:

```
ANTHROPIC_API_KEY=$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=nobigdeal-pro) node scripts/eval-ask-joe.mjs [--standalone]
```

**Results (Haiku 4.5): 10 runs × 8 questions, every answer within the rules.**
Each "✗" in the early runs was the GRADER being wrong, not Ask Joe:

- "It's **illegal** for contractors to negotiate insurance claims": the
  negation came before the match, and the old lookahead only checked after it.
- "Your **insurance** claim is between you and your carrier … you submit":
  the must-pattern only knew "your claim" and "you file".
- "If I negotiate your claim … that's **unlicensed** public adjusting": a
  warning.
- "…submit your claim and negotiate with your carrier if needed" and "If
  you need help negotiating the claim, you hire a **public adjuster**": the
  homeowner or a licensed third party negotiating is lawful (the site
  gate's THIRD_PARTY rule).

Fixed: a forbidden phrase counts only in a sentence with no negation, outside
the homeowner / public-adjuster cases, and the miss names the sentence. Each
case is pinned in `tests/claim-wording.test.js` §5, and un-negated "we'll
negotiate with the insurance company", "I negotiate with the adjuster" and
"on your behalf" still fail.

Answers vary run to run. Run the eval at least twice per surface after a
change; one clean pass proves little.

**Thursday** was read (production 0.6.2, read-only): no deposit or price
quoting and no AOB wording, but "can walk them through the claim" is the same
phrase PR #1993 removes from the site. That is Jo's call (a new agent
version and a test call). See
the CLAIM-WORDING-WALKTHROUGH-2026-10-02 audit note
once #1993 merges.

## Next

- ~~Run the eval once with a key~~: done, see the update above.
- Optionally, a weekly workflow, if Jo adds an `ANTHROPIC_API_KEY` repo
  secret.
- **Thursday:** export the Bland pathway's node prompts and add the same
  checks (claim wording; never quote a deposit on the phone).
